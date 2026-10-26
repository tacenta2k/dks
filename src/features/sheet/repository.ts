import {
  applyColumnOrder,
  canDeleteColumn,
  isGridSystemColumnId,
  normalizeColumns,
  sortColumnsByPosition,
  isDaysLeftColumn,
  type ColumnDefinition,
} from '../../lib/columns';
import { isValidIsoDate } from '../../lib/date';
import type {
  ColumnInput,
  RenewalRecord,
  SheetAuditEntry,
  SheetAuditOptions,
  SheetImportRecord,
  SheetRow,
  SheetSnapshot,
} from './types';

export interface SheetRepository {
  setRole?(role: string): void;
  getColumns(): Promise<ColumnDefinition[]>;
  getRows(): Promise<SheetRow[]>;
  addColumn(input: ColumnInput): Promise<ColumnDefinition>;
  updateColumn(columnId: string, patch: Partial<ColumnDefinition>): Promise<ColumnDefinition>;
  /**
   * Persist a user-chosen column order (drag-reorder). `columnIds` are the
   * active user columns in their new display order; implementations store
   * normalized `position` values (0..n-1) and return the full ordered list.
   * Optional so older adapters/test doubles stay assignable — SheetPage
   * falls back to per-column position updates when it is absent.
   */
  reorderColumns?(columnIds: readonly string[]): Promise<ColumnDefinition[]>;
  softDeleteColumn(columnId: string, role?: string): Promise<ColumnDefinition | null>;
  createRow(data?: Record<string, unknown>, category?: string | null): Promise<SheetRow>;
  updateRow(rowId: string, patch: Record<string, unknown>, category?: string | null): Promise<SheetRow>;
  duplicateRow(rowId: string): Promise<SheetRow>;
  softDeleteRow(rowId: string, options?: SheetAuditOptions): Promise<SheetRow>;
  /** Optional admin methods keep older adapters and test doubles assignable. */
  restoreRow?(rowId: string, options?: SheetAuditOptions): Promise<SheetRow>;
  permanentDeleteRow?(rowId: string, options?: SheetAuditOptions): Promise<SheetRow | null>;
  getAuditHistory?(): Promise<SheetAuditEntry[]>;
  /**
   * R2-10: administrator-only. Clears the mirrored audit history and records
   * exactly one entry describing the clear.
   */
  clearAuditLog?(message: string): Promise<SheetAuditEntry[]>;
  createRows?(records: readonly SheetImportRecord[], options?: SheetAuditOptions): Promise<SheetRow[]>;
  importRows?(records: readonly SheetImportRecord[], options?: SheetAuditOptions): Promise<SheetRow[]>;
  markRenewed(
    rowId: string,
    expiryColumnId: string,
    nextExpiry: string,
    previousExpiry?: string | null,
  ): Promise<SheetRow>;
  getRenewalHistory(rowId?: string): Promise<RenewalRecord[]>;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function now(): string {
  return new Date().toISOString();
}

let nextId = 1;

function makeId(prefix: string): string {
  const randomUuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : null;
  return randomUuid ? `${prefix}-${randomUuid}` : `${prefix}-${Date.now()}-${nextId++}`;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || `column_${nextId++}`;
}

function uniqueColumnId(name: string, columns: readonly ColumnDefinition[]): string {
  const used = new Set(columns.map((column) => column.id));
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix++}`;
  }
  return candidate;
}

function copyRows(rows: readonly SheetRow[]): SheetRow[] {
  return rows.map((row) => clone(row));
}

/**
 * Renderer-local repository used until the SQLite/IPC adapter is connected.
 * Its asynchronous surface intentionally mirrors the future adapter so the
 * page does not need to change when persistence moves out of the renderer.
 * No business columns are seeded; the sheet starts empty and users create
 * their own columns (F3).
 */
export class InMemorySheetRepository implements SheetRepository {
  private columns: ColumnDefinition[];

  private rows: SheetRow[];

  private renewals: RenewalRecord[];

  private auditHistory: SheetAuditEntry[];

  constructor(snapshot: Partial<SheetSnapshot> = {}) {
    this.columns = normalizeColumns(snapshot.columns ?? []);
    this.rows = copyRows(snapshot.rows ?? []);
    this.renewals = [];
    this.auditHistory = [];
  }

  async getColumns(): Promise<ColumnDefinition[]> {
    // `position` is the persisted order contract (SQLite returns
    // ORDER BY position); never trust incidental array order.
    return clone(sortColumnsByPosition(this.columns));
  }

  async getRows(): Promise<SheetRow[]> {
    return copyRows(this.rows);
  }

  async addColumn(input: ColumnInput): Promise<ColumnDefinition> {
    const id = input.id?.trim() || uniqueColumnId(input.name, this.columns);
    const column: ColumnDefinition = {
      id,
      name: input.name.trim(),
      type: input.type,
      ...(input.options ? { options: clone(input.options) } : {}),
      ...(input.isPassport || input.is_passport ? { isPassport: true, is_passport: true } : {}),
      position: this.columns.length,
      updatedAt: now(),
    };

    this.columns = normalizeColumns([...this.columns, column]);
    return clone(this.columns.find((candidate) => candidate.id === id) ?? column);
  }

  async updateColumn(columnId: string, patch: Partial<ColumnDefinition>): Promise<ColumnDefinition> {
    const index = this.columns.findIndex((column) => column.id === columnId);
    if (index < 0) {
      throw new Error(`Unknown sheet column: ${columnId}`);
    }

    const next = {
      ...this.columns[index],
      ...clone(patch),
      id: this.columns[index].id,
      updatedAt: now(),
    };
    this.columns = normalizeColumns(this.columns.map((column, currentIndex) => (
      currentIndex === index ? next : column
    )));
    return clone(this.columns[index]);
  }

  async reorderColumns(columnIds: readonly string[]): Promise<ColumnDefinition[]> {
    const seen = new Set<string>();
    for (const columnId of columnIds) {
      if (typeof columnId !== 'string' || !columnId.trim() || isGridSystemColumnId(columnId)) {
        throw new Error(`Unknown sheet column: ${String(columnId)}`);
      }
      if (seen.has(columnId)) {
        throw new Error(`Duplicate column id in reorder: ${columnId}`);
      }
      seen.add(columnId);
      const column = this.columns.find((candidate) => candidate.id === columnId);
      if (!column || column.deleted === true) {
        throw new Error(`Unknown sheet column: ${columnId}`);
      }
    }

    const previousPositions = new Map(this.columns.map((column) => [column.id, column.position]));
    const timestamp = now();
    // Only `position` (and the LWW timestamp of columns it actually moved)
    // changes — identity/type/options/passport/primary flags are untouched,
    // and normalizeColumns keeps it that way for the primary expiry.
    this.columns = normalizeColumns(applyColumnOrder(this.columns, columnIds).map((column) => (
      previousPositions.get(column.id) !== column.position
        ? { ...column, updatedAt: timestamp, updated_at: timestamp }
        : column
    )));
    return this.getColumns();
  }

  async softDeleteColumn(columnId: string, role = 'admin'): Promise<ColumnDefinition | null> {
    const target = this.columns.find((column) => column.id === columnId);
    if (!target || isDaysLeftColumn(target) || !canDeleteColumn(target, role, this.rows)) {
      return null;
    }

    this.columns = normalizeColumns(this.columns.map((column) => (
      column.id === columnId
        ? { ...column, deleted: true, visible: false, updatedAt: now() }
        : column
    )));
    return clone(this.columns.find((column) => column.id === columnId) ?? target);
  }

  async createRow(data: Record<string, unknown> = {}, category: string | null = null): Promise<SheetRow> {
    const timestamp = now();
    const row: SheetRow = {
      id: makeId('row'),
      data: clone(data),
      category: category ?? (typeof data.category === 'string' ? data.category : null),
      deleted: false,
      updatedAt: timestamp,
      updated_at: timestamp,
    };
    this.rows = [...this.rows, row];
    this.recordAudit('create', { rowId: row.id }, undefined);
    return clone(row);
  }

  async createRows(
    records: readonly SheetImportRecord[],
    options: SheetAuditOptions = {},
  ): Promise<SheetRow[]> {
    const created: SheetRow[] = [];
    for (const record of records) {
      created.push(await this.createRow(record.data, record.category ?? null));
    }
    if (records.length > 0) {
      this.recordAudit('create_many', {
        importedRows: records.length,
        ...(options.fileName ? { fileName: options.fileName } : {}),
      }, options);
    }
    return created;
  }

  async importRows(
    records: readonly SheetImportRecord[],
    options: SheetAuditOptions = {},
  ): Promise<SheetRow[]> {
    const created = await this.createRows(records, options);
    this.recordAudit('import', {
      fileName: options.fileName ?? null,
      importedRows: created.length,
      sourceRows: records
        .map((record) => record.sourceRowNumber)
        .filter((rowNumber): rowNumber is number => rowNumber !== undefined),
    }, options);
    return created;
  }

  async updateRow(
    rowId: string,
    patch: Record<string, unknown>,
    category?: string | null,
  ): Promise<SheetRow> {
    const index = this.rows.findIndex((row) => row.id === rowId);
    if (index < 0) {
      throw new Error(`Unknown sheet row: ${rowId}`);
    }

    const previous = this.rows[index];
    const nextCategory = category === undefined
      ? (typeof patch.category === 'string' ? patch.category : previous.category)
      : category;
    const updated: SheetRow = {
      ...previous,
      data: { ...previous.data, ...clone(patch) },
      category: nextCategory,
      updatedAt: now(),
      updated_at: now(),
    };
    this.rows = this.rows.map((row, currentIndex) => currentIndex === index ? updated : row);
    this.recordAudit('update', { rowId });
    return clone(updated);
  }

  async duplicateRow(rowId: string): Promise<SheetRow> {
    const source = this.rows.find((row) => row.id === rowId);
    if (!source) {
      throw new Error(`Unknown sheet row: ${rowId}`);
    }
    return this.createRow(source.data, source.category);
  }

  async softDeleteRow(rowId: string, options: SheetAuditOptions = {}): Promise<SheetRow> {
    const index = this.rows.findIndex((row) => row.id === rowId);
    if (index < 0) {
      throw new Error(`Unknown sheet row: ${rowId}`);
    }

    const updated: SheetRow = {
      ...this.rows[index],
      deleted: true,
      updatedAt: now(),
      updated_at: now(),
    };
    this.rows = this.rows.map((row, currentIndex) => currentIndex === index ? updated : row);
    this.recordAudit('soft_delete', { rowId }, options);
    return clone(updated);
  }

  async restoreRow(rowId: string, options: SheetAuditOptions = {}): Promise<SheetRow> {
    const index = this.rows.findIndex((row) => row.id === rowId);
    if (index < 0) {
      throw new Error(`Unknown sheet row: ${rowId}`);
    }

    const timestamp = now();
    const restored: SheetRow = {
      ...this.rows[index],
      deleted: false,
      updatedAt: timestamp,
      updated_at: timestamp,
    };
    this.rows = this.rows.map((row, currentIndex) => currentIndex === index ? restored : row);
    this.recordAudit('restore', { rowId }, options);
    return clone(restored);
  }

  async permanentDeleteRow(rowId: string, options: SheetAuditOptions = {}): Promise<SheetRow | null> {
    const index = this.rows.findIndex((row) => row.id === rowId);
    if (index < 0) {
      return null;
    }

    const [removed] = this.rows.splice(index, 1);
    this.recordAudit('permanent_delete', { rowId }, options);
    return removed ? clone(removed) : null;
  }

  async markRenewed(
    rowId: string,
    expiryColumnId: string,
    nextExpiry: string,
    previousExpiry?: string | null,
  ): Promise<SheetRow> {
    if (!isValidIsoDate(nextExpiry)) {
      throw new Error('Renewal expiry must be a valid ISO date');
    }

    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const todayDay = Date.UTC(
      Number(todayIso.slice(0, 4)),
      Number(todayIso.slice(5, 7)) - 1,
      Number(todayIso.slice(8, 10)),
    );
    const nextExpiryDay = Date.UTC(
      Number(nextExpiry.slice(0, 4)),
      Number(nextExpiry.slice(5, 7)) - 1,
      Number(nextExpiry.slice(8, 10)),
    );
    if (nextExpiryDay <= todayDay) {
      throw new Error('Renewal expiry must be in the future');
    }

    const row = this.rows.find((candidate) => candidate.id === rowId);
    if (!row) {
      throw new Error(`Unknown sheet row: ${rowId}`);
    }

    const previous = previousExpiry
      ?? (typeof row.data[expiryColumnId] === 'string' ? row.data[expiryColumnId] : null);
    const updated = await this.updateRow(rowId, { [expiryColumnId]: nextExpiry });
    this.renewals = [
      ...this.renewals,
      {
        id: makeId('renewal'),
        rowId,
        expiryColumnId,
        previousExpiry: previous,
        nextExpiry,
        renewedAt: now(),
      },
    ];
    return updated;
  }

  async getRenewalHistory(rowId?: string): Promise<RenewalRecord[]> {
    return clone(rowId ? this.renewals.filter((renewal) => renewal.rowId === rowId) : this.renewals);
  }

  async getAuditHistory(): Promise<SheetAuditEntry[]> {
    return clone(this.auditHistory);
  }

  async clearAuditLog(message: string): Promise<SheetAuditEntry[]> {
    this.auditHistory = [{
      id: makeId('audit'),
      action: 'clear_audit',
      actorId: null,
      actor: null,
      timestamp: now(),
      details: { message },
    }];
    return clone(this.auditHistory);
  }

  private recordAudit(
    action: string,
    details: Record<string, unknown> = {},
    options: SheetAuditOptions = {},
  ): void {
    this.auditHistory = [
      ...this.auditHistory,
      {
        id: makeId('audit'),
        action,
        actorId: options.actorId ?? null,
        actor: options.actor ?? null,
        timestamp: now(),
        details,
      },
    ];
  }
}

export function createInMemorySheetRepository(
  snapshot: Partial<SheetSnapshot> = {},
): InMemorySheetRepository {
  return new InMemorySheetRepository(snapshot);
}

export const createSheetRepository = createInMemorySheetRepository;
