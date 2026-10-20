import { isValidIsoDate } from '../../lib/date';
import type {
  ColumnDefinition,
} from '../../lib/columns';
import type {
  DksLocalApi,
  DksLocalAuditRecord,
  DksLocalColumn,
  DksLocalRow,
  DksLocalSnapshot,
  DksWindowApi,
} from '../../lib/types';
import {
  createInMemorySheetRepository,
  type SheetRepository,
} from './repository';
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

interface WindowWithDks {
  dks?: Pick<DksWindowApi, 'local'>;
  platform?: string;
  appVersion?: string;
  minimizeToTray?: () => void;
  quit?: () => void;
}

export interface ElectronSheetRepositoryOptions {
  /** Injectable window boundary for tests and non-browser consumers. */
  windowApi?: WindowWithDks | DksWindowApi | Partial<DksWindowApi>;
  /** `window` is accepted as a readable alias for embedders. */
  window?: WindowWithDks | DksWindowApi | Partial<DksWindowApi>;
  fallback?: SheetRepository;
  role?: string;
}

type RepositoryConstructorInput = ElectronSheetRepositoryOptions | WindowWithDks | DksWindowApi | Partial<DksWindowApi>;

function isOptions(value: RepositoryConstructorInput): value is ElectronSheetRepositoryOptions {
  if (!value || typeof value !== 'object') {
    return true;
  }

  return 'windowApi' in value || 'window' in value || 'fallback' in value || 'role' in value;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function localRow(value: DksLocalRow | null | undefined, label: string): SheetRow | null {
  if (!value) {
    return null;
  }

  const source = record(value);
  if (typeof source.id !== 'string' || typeof source.data !== 'object' || source.data === null) {
    throw new Error(`The local bridge returned an invalid ${label}`);
  }

  const updatedAt = typeof source.updatedAt === 'string'
    ? source.updatedAt
    : typeof source.updated_at === 'string'
      ? source.updated_at
      : undefined;
  const category = source.category === null || typeof source.category === 'string'
    ? source.category
    : undefined;

  return {
    id: source.id,
    data: clone(source.data as Record<string, unknown>),
    ...(category !== undefined ? { category } : {}),
    ...(typeof source.deleted === 'boolean' ? { deleted: source.deleted } : {}),
    ...(updatedAt ? { updatedAt, updated_at: updatedAt } : {}),
  };
}

function requiredRow(value: DksLocalRow | null | undefined, label: string): SheetRow {
  const result = localRow(value, label);
  if (!result) {
    throw new Error(`The local bridge did not return a ${label}`);
  }
  return result;
}

function localColumn(value: DksLocalColumn | null | undefined, label: string): ColumnDefinition | null {
  if (!value) {
    return null;
  }

  const source = record(value);
  if (typeof source.id !== 'string' || typeof source.name !== 'string' || typeof source.type !== 'string') {
    throw new Error(`The local bridge returned an invalid ${label}`);
  }

  const updatedAt = typeof source.updatedAt === 'string'
    ? source.updatedAt
    : typeof source.updated_at === 'string'
      ? source.updated_at
      : undefined;
  return {
    id: source.id,
    name: source.name,
    type: source.type as ColumnDefinition['type'],
    ...(source.options !== undefined ? { options: source.options as ColumnDefinition['options'] } : {}),
    ...(typeof source.position === 'number' ? { position: source.position } : {}),
    ...(typeof source.visible === 'boolean' ? { visible: source.visible } : {}),
    ...(typeof source.isPrimaryExpiry === 'boolean' ? { isPrimaryExpiry: source.isPrimaryExpiry } : {}),
    ...(typeof source.is_primary_expiry === 'boolean' ? { is_primary_expiry: source.is_primary_expiry } : {}),
    ...(typeof source.isPassport === 'boolean' ? { isPassport: source.isPassport } : {}),
    ...(typeof source.is_passport === 'boolean' ? { is_passport: source.is_passport } : {}),
    ...(typeof source.deleted === 'boolean' ? { deleted: source.deleted } : {}),
    ...(updatedAt ? { updatedAt, updated_at: updatedAt } : {}),
  };
}

function requiredColumn(value: DksLocalColumn | null | undefined, label: string): ColumnDefinition {
  const result = localColumn(value, label);
  if (!result) {
    throw new Error(`The local bridge did not return a ${label}`);
  }
  return result;
}

function windowApiFrom(value: WindowWithDks | DksWindowApi | Partial<DksWindowApi> | undefined): WindowWithDks | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if ('dks' in value) {
    return value as WindowWithDks;
  }
  return { dks: value as DksWindowApi };
}

function defaultWindow(): WindowWithDks | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return window as unknown as WindowWithDks;
}

function uniqueRows(rows: readonly SheetRow[]): SheetRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) {
      return false;
    }
    seen.add(row.id);
    return true;
  });
}

function auditEntry(value: DksLocalAuditRecord): SheetAuditEntry {
  const source = record(value);
  const actor = source.actor;
  const actorId = typeof source.actorId === 'string'
    ? source.actorId
    : typeof actor === 'string'
      ? actor
      : null;
  const timestamp = typeof source.createdAt === 'string'
    ? source.createdAt
    : typeof source.timestamp === 'string'
      ? source.timestamp
      : undefined;
  const details = source.details ?? {
    ...(source.before !== undefined ? { before: source.before } : {}),
    ...(source.after !== undefined ? { after: source.after } : {}),
  };

  return {
    id: String(source.id ?? ''),
    action: typeof source.action === 'string' ? source.action : 'unknown',
    actorId,
    actor: typeof actor === 'string' ? actor : null,
    ...(timestamp ? { timestamp, createdAt: timestamp } : {}),
    details,
  };
}

function makeRenewalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `renewal-${crypto.randomUUID()}`;
  }
  return `renewal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Renderer-side SheetRepository implementation backed only by the preload
 * bridge. It deliberately contains no Electron or SQLite imports.
 */
export class ElectronSheetRepository implements SheetRepository {
  private readonly sourceWindow: WindowWithDks | undefined;

  private readonly fallback: SheetRepository;

  private role: string;

  private renewals: RenewalRecord[] = [];

  public constructor(input: RepositoryConstructorInput = {}) {
    if (isOptions(input)) {
      this.sourceWindow = windowApiFrom(input.windowApi ?? input.window) ?? defaultWindow();
      this.fallback = input.fallback ?? createInMemorySheetRepository();
      this.role = input.role?.trim() || 'admin';
      return;
    }

    this.sourceWindow = windowApiFrom(input) ?? defaultWindow();
    this.fallback = createInMemorySheetRepository();
    this.role = 'admin';
  }

  /** Keep local IPC role checks aligned with the authenticated profile. */
  public setRole(role: string): void {
    const normalized = role.trim();
    if (normalized === 'admin' || normalized === 'office') {
      this.role = normalized;
    }
  }

  private local(): DksLocalApi | null {
    try {
      const local = this.sourceWindow?.dks?.local;
      return local && typeof local === 'object' ? local : null;
    } catch {
      return null;
    }
  }

  private async use<T>(
    method: keyof DksLocalApi,
    invoke: (local: DksLocalApi) => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    const local = this.local();
    const candidate = local ? (local as unknown as Record<string, unknown>)[method] : undefined;
    if (!local || typeof candidate !== 'function') {
      return fallback();
    }
    // Do not catch bridge errors here. A present bridge is authoritative and
    // callers must see an offline/database failure instead of stale fallback data.
    return invoke(local);
  }

  private async snapshot(): Promise<DksLocalSnapshot> {
    return this.use<DksLocalSnapshot>(
      'getSnapshot',
      (local) => local.getSnapshot(),
      async () => {
        const rows = (await this.fallback.getRows()) as DksLocalRow[];
        const activeRows = rows.filter((row) => row.deleted !== true);
        return {
          rows: activeRows,
          activeRows,
          deletedRows: rows.filter((row) => row.deleted === true),
          columns: (await this.fallback.getColumns()) as DksLocalColumn[],
          syncStatus: { status: 'offline' as const, lastSyncAt: null, lastError: null, pendingCount: 0 },
        };
      },
    );
  }

  async getColumns(): Promise<ColumnDefinition[]> {
    const snapshot = await this.snapshot();
    return clone(snapshot.columns
      .map((column) => localColumn(column, 'column'))
      .filter((column): column is ColumnDefinition => column !== null && column.deleted !== true));
  }

  async getRows(): Promise<SheetRow[]> {
    const snapshot = await this.snapshot();
    const rows = [
      ...(snapshot.rows ?? snapshot.activeRows ?? []).map((row) => localRow(row, 'row')),
      ...(snapshot.deletedRows ?? []).map((row) => localRow(row, 'deleted row')),
    ].filter((row): row is SheetRow => row !== null);
    return clone(uniqueRows(rows));
  }

  async getTemplates(): Promise<SheetTemplate[]> {
    return this.fallback.getTemplates();
  }

  async loadTemplate(templateId: string): Promise<SheetSnapshot> {
    return this.fallback.loadTemplate(templateId);
  }

  async addColumn(input: ColumnInput): Promise<ColumnDefinition> {
    return this.use(
      'addColumn',
      async (local) => requiredColumn(await local.addColumn({
        ...input,
        role: this.role,
      }), 'created column'),
      () => this.fallback.addColumn(input),
    );
  }

  async updateColumn(columnId: string, patch: Partial<ColumnDefinition>): Promise<ColumnDefinition> {
    return this.use(
      'updateColumn',
      async (local) => requiredColumn(await local.updateColumn({
        id: columnId,
        patch: clone(patch),
        role: this.role,
      }), 'updated column'),
      () => this.fallback.updateColumn(columnId, patch),
    );
  }

  async softDeleteColumn(columnId: string, role = this.role): Promise<ColumnDefinition | null> {
    return this.use(
      'deleteColumn',
      async (local) => localColumn(await local.deleteColumn({ id: columnId, role }), 'deleted column'),
      () => this.fallback.softDeleteColumn(columnId, role),
    );
  }

  async createRow(data: Record<string, unknown> = {}, category: string | null = null): Promise<SheetRow> {
    return this.use(
      'createRow',
      (local) => local.createRow({ data: clone(data), category }),
      () => this.fallback.createRow(data, category),
    ).then((row) => requiredRow(row, 'created row'));
  }

  async updateRow(
    rowId: string,
    patch: Record<string, unknown>,
    category?: string | null,
  ): Promise<SheetRow> {
    return this.use(
      'updateRow',
      (local) => local.updateRow({
        id: rowId,
        data: clone(patch),
        ...(category !== undefined ? { category } : {}),
      }),
      () => this.fallback.updateRow(rowId, patch, category),
    ).then((row) => requiredRow(row, 'updated row'));
  }

  async duplicateRow(rowId: string): Promise<SheetRow> {
    return this.use(
      'duplicateRow',
      (local) => local.duplicateRow({ id: rowId }),
      () => this.fallback.duplicateRow(rowId),
    ).then((row) => requiredRow(row, 'duplicated row'));
  }

  async softDeleteRow(rowId: string): Promise<SheetRow> {
    return this.use(
      'softDeleteRow',
      (local) => local.softDeleteRow({ id: rowId }),
      () => this.fallback.softDeleteRow(rowId),
    ).then((row) => requiredRow(row, 'deleted row'));
  }

  async restoreRow(rowId: string, options: SheetAuditOptions = {}): Promise<SheetRow> {
    return this.use(
      'restoreRow',
      (local) => local.restoreRow({
        id: rowId,
        role: this.role,
        actorId: options.actorId,
        actor: options.actor,
      }),
      () => {
        if (!this.fallback.restoreRow) {
          return Promise.reject(new Error('Row restore is unavailable'));
        }
        return this.fallback.restoreRow(rowId, options);
      },
    ).then((row) => requiredRow(row, 'restored row'));
  }

  async permanentDeleteRow(rowId: string, options: SheetAuditOptions = {}): Promise<SheetRow | null> {
    return this.use(
      'permanentDeleteRow',
      (local) => local.permanentDeleteRow({
        id: rowId,
        role: this.role,
        actorId: options.actorId,
        actor: options.actor,
      }),
      () => {
        if (!this.fallback.permanentDeleteRow) {
          return Promise.resolve(null);
        }
        return this.fallback.permanentDeleteRow(rowId, options);
      },
    ).then((row) => localRow(row, 'permanently deleted row'));
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
    if (nextExpiry <= todayIso) {
      throw new Error('Renewal expiry must be in the future');
    }

    const row = (await this.getRows()).find((candidate) => candidate.id === rowId);
    if (!row) {
      throw new Error(`Unknown sheet row: ${rowId}`);
    }
    const previous = previousExpiry
      ?? (typeof row.data[expiryColumnId] === 'string' ? row.data[expiryColumnId] : null);
    const updated = await this.updateRow(rowId, { [expiryColumnId]: nextExpiry });
    this.renewals = [
      ...this.renewals,
      {
        id: makeRenewalId(),
        rowId,
        expiryColumnId,
        previousExpiry: previous,
        nextExpiry,
        renewedAt: new Date().toISOString(),
      },
    ];
    return updated;
  }

  async getRenewalHistory(rowId?: string): Promise<RenewalRecord[]> {
    return clone(rowId ? this.renewals.filter((renewal) => renewal.rowId === rowId) : this.renewals);
  }

  async getAuditHistory(): Promise<SheetAuditEntry[]> {
    return this.use(
      'listAudit',
      async (local) => (await local.listAudit({ limit: 500 })).map(auditEntry),
      async () => this.fallback.getAuditHistory ? this.fallback.getAuditHistory() : [],
    );
  }

  async createRows(
    records: readonly SheetImportRecord[],
    options: SheetAuditOptions = {},
  ): Promise<SheetRow[]> {
    return this.use(
      'importRecords',
      async (local) => (await local.importRecords({ records: clone(records), options: clone(options) }))
        .map((row) => requiredRow(row, 'imported row')),
      async () => {
        if (this.fallback.createRows) {
          return this.fallback.createRows(records, options);
        }
        const result: SheetRow[] = [];
        for (const record of records) {
          result.push(await this.fallback.createRow(record.data, record.category ?? null));
        }
        return result;
      },
    );
  }

  async importRows(
    records: readonly SheetImportRecord[],
    options: SheetAuditOptions = {},
  ): Promise<SheetRow[]> {
    return this.createRows(records, options);
  }
}

export function createElectronSheetRepository(
  options: ElectronSheetRepositoryOptions = {},
): ElectronSheetRepository {
  return new ElectronSheetRepository(options);
}

export const createLocalSheetRepository = createElectronSheetRepository;
