import { isValidIsoDate } from '../../lib/date';
import {
  applyColumnOrder,
  normalizeColumns,
  sortColumnsByPosition,
  type ColumnDefinition,
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
  SheetCreateRowOptions,
  SheetImportRecord,
  SheetRow,
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
    entityType: typeof source.entityType === 'string' ? source.entityType : null,
    entityId: typeof source.entityId === 'string' ? source.entityId : null,
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

  /**
   * A single in-flight snapshot shared by concurrent `getColumns()` /
   * `getRows()` callers. Every host awaits the two together in `Promise.all`,
   * so without coalescing each sheet load (and each quiet refresh) paid for
   * two full SQLite snapshot builds plus two IPC structured clones. The slot
   * is released as soon as the promise settles, so later reads — including
   * quiet refreshes — always start a fresh snapshot.
   */
  private snapshotInFlight: { role: string; promise: Promise<DksLocalSnapshot> } | null = null;

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
    // Reuse only a snapshot taken for the SAME role: a role switch must never
    // hand a caller another scope's rows even if a read is mid-flight.
    const inFlight = this.snapshotInFlight;
    if (inFlight && inFlight.role === this.role) {
      return inFlight.promise;
    }
    const promise = this.loadSnapshot().finally(() => {
      if (this.snapshotInFlight?.promise === promise) {
        this.snapshotInFlight = null;
      }
    });
    this.snapshotInFlight = { role: this.role, promise };
    return promise;
  }

  private async loadSnapshot(): Promise<DksLocalSnapshot> {
    return this.use<DksLocalSnapshot>(
      'getSnapshot',
      // The validated role parameter (existing role mechanism) scopes Office
      // reads to the 3-day creation window inside the local store.
      (local) => local.getSnapshot({ role: this.role }),
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
    // normalizeColumns heals the primary-expiry invariant in memory as well
    // (stale flags are dropped) so persisted junk can never leak into guards
    // driven by these columns. Sorting by `position` makes the persisted
    // column order the rendered order for every bridge, not just SQLite's
    // ORDER BY — a user-saved drag order must survive every reload.
    return sortColumnsByPosition(normalizeColumns(clone(snapshot.columns
      .map((column) => localColumn(column, 'column'))
      .filter((column): column is ColumnDefinition => column !== null && column.deleted !== true))));
  }

  async getRows(): Promise<SheetRow[]> {
    const snapshot = await this.snapshot();
    const rows = [
      ...(snapshot.rows ?? snapshot.activeRows ?? []).map((row) => localRow(row, 'row')),
      ...(snapshot.deletedRows ?? []).map((row) => localRow(row, 'deleted row')),
    ].filter((row): row is SheetRow => row !== null);
    return clone(uniqueRows(rows));
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

  /**
   * Persist a drag-reorder. Preferred path is the bridge's atomic
   * position-only reorder (one SQLite transaction + one outbox item per
   * moved column). A bridge without it (older preload) still persists the
   * same normalized positions through sequential position updates against
   * the SAME authority — never silently against the empty fallback.
   */
  async reorderColumns(columnIds: readonly string[]): Promise<ColumnDefinition[]> {
    const local = this.local();
    if (local && typeof local.reorderColumns === 'function') {
      const result = await local.reorderColumns({
        columnIds: [...columnIds],
        role: this.role,
      });
      return sortColumnsByPosition(normalizeColumns(result
        .map((column) => localColumn(column, 'column'))
        .filter((column): column is ColumnDefinition => column !== null && column.deleted !== true)));
    }

    const sequential = async (target: {
      getColumns: () => Promise<ColumnDefinition[]>;
      updateColumn: (id: string, patch: Partial<ColumnDefinition>) => Promise<ColumnDefinition>;
    }): Promise<ColumnDefinition[]> => {
      const current = await target.getColumns();
      const reordered = applyColumnOrder(current, columnIds);
      for (const column of reordered) {
        const previous = current.find((candidate) => candidate.id === column.id);
        if (previous && previous.position !== column.position) {
          await target.updateColumn(column.id, { position: column.position });
        }
      }
      return target.getColumns();
    };

    if (local && typeof local.updateColumn === 'function') {
      return sequential(this);
    }
    if (this.fallback.reorderColumns) {
      return this.fallback.reorderColumns(columnIds);
    }
    return sequential(this.fallback);
  }

  async softDeleteColumn(columnId: string, role = this.role): Promise<ColumnDefinition | null> {
    return this.use(
      'deleteColumn',
      async (local) => localColumn(await local.deleteColumn({ id: columnId, role }), 'deleted column'),
      () => this.fallback.softDeleteColumn(columnId, role),
    );
  }

  /**
   * R3 batch B — adopt the server's column id after a duplicate-name
   * reconciliation. The local store rewrites the entry JSON keys, so every
   * value stays attached to the same (now server-identified) column.
   */
  async rekeyColumn(oldId: string, newId: string): Promise<void> {
    await this.use(
      'rekeyColumn',
      async (local) => {
        if (!local.rekeyColumn) {
          throw new Error('Column reconciliation is unavailable in this local store');
        }
        const result = await local.rekeyColumn({ oldId, newId });
        if (result?.ok !== true) {
          throw new Error('The local column could not be reconciled with the server id');
        }
        return undefined;
      },
      async () => undefined,
    );
  }

  async createRow(
    data: Record<string, unknown> = {},
    category: string | null = null,
    options: SheetCreateRowOptions = {},
  ): Promise<SheetRow> {
    // Bug 2: forward the stable client identity so the main-process store
    // can recognise a retried create and return the existing row instead of
    // minting a fresh UUID (and a second outbox create) per call.
    return this.use(
      'createRow',
      (local) => local.createRow({
        data: clone(data),
        category,
        ...(options.id ? { id: options.id } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      }),
      () => this.fallback.createRow(data, category, options),
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

  async softDeleteRow(rowId: string, options: SheetAuditOptions = {}): Promise<SheetRow> {
    return this.use(
      'softDeleteRow',
      (local) => local.softDeleteRow({
        id: rowId,
        role: this.role,
        actorId: options.actorId,
        actor: options.actor,
        updatedBy: options.actor ?? null,
      }),
      () => this.fallback.softDeleteRow(rowId, options),
    ).then((row) => requiredRow(row, 'deleted row'));
  }

  /**
   * Bug 4: bulk soft-delete. Preferred path is the bridge's atomic bulk
   * channel (one SQLite transaction, role-checked in preload AND main).
   * A bridge without it (older preload) still deletes against the SAME
   * authority through sequential single deletes after validating that
   * every target exists and is active — never against the empty fallback.
   */
  async softDeleteRows(
    rowIds: readonly string[],
    options: SheetAuditOptions = {},
  ): Promise<SheetRow[]> {
    const local = this.local();
    if (local && typeof local.softDeleteRows === 'function') {
      const rows = await local.softDeleteRows({
        ids: [...rowIds],
        role: this.role,
        actorId: options.actorId,
        actor: options.actor,
        updatedBy: options.actor ?? null,
      });
      return rows.map((row) => requiredRow(row, 'deleted row'));
    }
    if (local && typeof local.softDeleteRow === 'function') {
      const current = await this.getRows();
      const byId = new Map(current.map((row) => [row.id, row]));
      for (const rowId of rowIds) {
        const row = byId.get(rowId);
        if (!row || row.deleted === true) {
          throw new Error(row ? `Row is already in the Recycle Bin: ${rowId}` : `Unknown sheet row: ${rowId}`);
        }
      }
      const deleted: SheetRow[] = [];
      for (const rowId of rowIds) {
        deleted.push(await this.softDeleteRow(rowId, options));
      }
      return deleted;
    }
    if (this.fallback.softDeleteRows) {
      return this.fallback.softDeleteRows(rowIds, options);
    }
    const deleted: SheetRow[] = [];
    for (const rowId of rowIds) {
      deleted.push(await this.fallback.softDeleteRow(rowId, options));
    }
    return deleted;
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

  async clearAuditLog(message: string, options: SheetAuditOptions = {}): Promise<SheetAuditEntry[]> {
    await this.use(
      'clearAuditLog',
      async (local) => {
        if (!local.clearAuditLog) {
          throw new Error('Audit log clearing is unavailable in this local store');
        }
        await local.clearAuditLog({
          message,
          role: String(this.role ?? 'admin'),
          actor: options.actorId ?? options.actor ?? null,
        });
        return undefined;
      },
      async () => {
        if (this.fallback.clearAuditLog) {
          await this.fallback.clearAuditLog(message);
        }
        return undefined;
      },
    );
    return this.getAuditHistory();
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
