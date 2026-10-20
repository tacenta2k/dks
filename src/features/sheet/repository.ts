import {
  canDeleteColumn,
  normalizeColumns,
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
  SheetTemplate,
} from './types';

export interface SheetRepository {
  setRole?(role: string): void;
  getColumns(): Promise<ColumnDefinition[]>;
  getRows(): Promise<SheetRow[]>;
  getTemplates(): Promise<SheetTemplate[]>;
  loadTemplate(templateId: string): Promise<SheetSnapshot>;
  addColumn(input: ColumnInput): Promise<ColumnDefinition>;
  updateColumn(columnId: string, patch: Partial<ColumnDefinition>): Promise<ColumnDefinition>;
  softDeleteColumn(columnId: string, role?: string): Promise<ColumnDefinition | null>;
  createRow(data?: Record<string, unknown>, category?: string | null): Promise<SheetRow>;
  updateRow(rowId: string, patch: Record<string, unknown>, category?: string | null): Promise<SheetRow>;
  duplicateRow(rowId: string): Promise<SheetRow>;
  softDeleteRow(rowId: string): Promise<SheetRow>;
  /** Optional admin methods keep older adapters and test doubles assignable. */
  restoreRow?(rowId: string, options?: SheetAuditOptions): Promise<SheetRow>;
  permanentDeleteRow?(rowId: string, options?: SheetAuditOptions): Promise<SheetRow | null>;
  getAuditHistory?(): Promise<SheetAuditEntry[]>;
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

const VISA_TEMPLATE_ID = 'visa';

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

function visaTemplate(): SheetTemplate {
  return {
    id: VISA_TEMPLATE_ID,
    name: 'Visa Template',
    description: 'A practical starting sheet for passport and visa expiry tracking.',
    columns: normalizeColumns([
      { id: 'name', name: 'Name', type: 'text', position: 0 },
      {
        id: 'category',
        name: 'Category',
        type: 'dropdown',
        options: ['Employee', 'Family', 'Client'],
        position: 1,
      },
      {
        id: 'passport_no',
        name: 'Passport No',
        type: 'text',
        isPassport: true,
        position: 2,
      },
      {
        id: 'visa_type',
        name: 'Visa Type',
        type: 'dropdown',
        options: ['Visit', 'Work', 'Family', 'Resident'],
        position: 3,
      },
      { id: 'country', name: 'Country', type: 'text', position: 4 },
      { id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', position: 5 },
      { id: 'phone', name: 'Phone', type: 'phone', position: 6 },
      { id: 'notes', name: 'Notes', type: 'notes', position: 7 },
    ]),
    rows: [],
  };
}

function copyRows(rows: readonly SheetRow[]): SheetRow[] {
  return rows.map((row) => clone(row));
}

/**
 * Renderer-local repository used until the SQLite/IPC adapter is connected.
 * Its asynchronous surface intentionally mirrors the future adapter so the
 * page does not need to change when persistence moves out of the renderer.
 */
export class InMemorySheetRepository implements SheetRepository {
  private columns: ColumnDefinition[];

  private rows: SheetRow[];

  private templates: SheetTemplate[];

  private renewals: RenewalRecord[];

  private auditHistory: SheetAuditEntry[];

  constructor(snapshot: Partial<SheetSnapshot> = {}, templates?: SheetTemplate[]) {
    this.columns = normalizeColumns(snapshot.columns ?? []);
    this.rows = copyRows(snapshot.rows ?? []);
    this.templates = templates?.map((template) => clone(template)) ?? [visaTemplate()];
    this.renewals = [];
    this.auditHistory = [];
  }

  async getColumns(): Promise<ColumnDefinition[]> {
    return clone(this.columns);
  }

  async getRows(): Promise<SheetRow[]> {
    return copyRows(this.rows);
  }

  async getTemplates(): Promise<SheetTemplate[]> {
    return clone(this.templates);
  }

  async loadTemplate(templateId: string): Promise<SheetSnapshot> {
    const template = this.templates.find((candidate) => candidate.id === templateId);
    if (!template) {
      throw new Error(`Unknown sheet template: ${templateId}`);
    }

    this.columns = normalizeColumns(template.columns);
    this.rows = copyRows(template.rows ?? []);
    this.renewals = [];
    return { columns: await this.getColumns(), rows: await this.getRows() };
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

  async softDeleteRow(rowId: string): Promise<SheetRow> {
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
    this.recordAudit('soft_delete', { rowId });
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
