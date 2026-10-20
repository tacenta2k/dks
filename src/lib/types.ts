export type ThemePreference = 'light' | 'dark' | 'system';

export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

export type AppView = 'dashboard' | 'sheet';

export type DksLocalSyncStatus = 'offline' | 'syncing' | 'healthy' | 'error';

export interface DksLocalSyncState {
  status: DksLocalSyncStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingCount: number;
}

/** Values crossing the renderer/main boundary are plain structured-clone data. */
export interface DksLocalRow {
  id: string;
  data: Record<string, unknown>;
  category?: string | null;
  deleted?: boolean;
  deletedAt?: string | null;
  deleted_at?: string | null;
  version?: number;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  updatedBy?: string | null;
  updated_by?: string | null;
}

export interface DksLocalColumn {
  id: string;
  name: string;
  type: string;
  options?: unknown;
  position?: number;
  visible?: boolean;
  isPrimaryExpiry?: boolean;
  is_primary_expiry?: boolean;
  isPassport?: boolean;
  is_passport?: boolean;
  deleted?: boolean;
  deletedAt?: string | null;
  deleted_at?: string | null;
  updatedAt?: string;
  updated_at?: string;
}

export interface DksLocalSnapshot {
  rows: DksLocalRow[];
  /** Alias retained for callers that distinguish active/deleted collections. */
  activeRows?: DksLocalRow[];
  deletedRows: DksLocalRow[];
  columns: DksLocalColumn[];
  syncStatus: DksLocalSyncState;
}

export interface DksLocalCreateRowInput {
  id?: string;
  data: Record<string, unknown>;
  category?: string | null;
  idempotencyKey?: string;
  updatedBy?: string | null;
}

export interface DksLocalUpdateRowInput {
  id: string;
  data?: Record<string, unknown>;
  category?: string | null;
  deleted?: boolean;
  deletedAt?: string | null;
  idempotencyKey?: string;
  updatedBy?: string | null;
}

export interface DksLocalRowCommand {
  id: string;
  idempotencyKey?: string;
  updatedBy?: string | null;
  actorId?: string | null;
  actor?: string | null;
  role?: string;
}

export interface DksLocalColumnInput {
  id?: string;
  name: string;
  type: string;
  options?: unknown;
  position?: number;
  visible?: boolean;
  isPrimaryExpiry?: boolean;
  isPassport?: boolean;
  deleted?: boolean;
  role?: string;
  idempotencyKey?: string;
}

export interface DksLocalUpdateColumnInput {
  id: string;
  patch: Partial<DksLocalColumn>;
  role?: string;
  idempotencyKey?: string;
}

export interface DksLocalImportRecord {
  data: Record<string, unknown>;
  category?: string | null;
  sourceRowNumber?: number;
}

export interface DksLocalAuditOptions {
  actorId?: string | null;
  actor?: string | null;
  fileName?: string | null;
}

export interface DksLocalAuditRecord {
  id: number | string;
  actor?: string | null;
  actorId?: string | null;
  entityType?: string;
  entityId?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  details?: Record<string, unknown>;
  createdAt?: string;
  timestamp?: string;
}

export interface DksLocalNotificationRecord {
  id: number | string;
  type: string;
  message: string;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DksLocalBackupResult {
  fileName: string;
  bytes: number;
  createdAt: string;
  sha256: string;
}

export interface DksLocalCloseResult {
  closed: boolean;
  flushed: boolean;
}

export interface DksLocalApi {
  getSnapshot: () => Promise<DksLocalSnapshot>;
  createRow: (input: DksLocalCreateRowInput) => Promise<DksLocalRow>;
  updateRow: (input: DksLocalUpdateRowInput) => Promise<DksLocalRow | null>;
  duplicateRow: (input: DksLocalRowCommand) => Promise<DksLocalRow | null>;
  softDeleteRow: (input: DksLocalRowCommand) => Promise<DksLocalRow | null>;
  restoreRow: (input: DksLocalRowCommand) => Promise<DksLocalRow | null>;
  permanentDeleteRow: (input: DksLocalRowCommand) => Promise<DksLocalRow | null>;
  addColumn: (input: DksLocalColumnInput) => Promise<DksLocalColumn>;
  updateColumn: (input: DksLocalUpdateColumnInput) => Promise<DksLocalColumn | null>;
  deleteColumn: (input: DksLocalRowCommand & { role: string }) => Promise<DksLocalColumn | null>;
  importRecords: (input: {
    records: readonly DksLocalImportRecord[];
    options?: DksLocalAuditOptions;
  }) => Promise<DksLocalRow[]>;
  listAudit: (input?: { limit?: number }) => Promise<DksLocalAuditRecord[]>;
  listNotifications: (input?: { unreadOnly?: boolean }) => Promise<DksLocalNotificationRecord[]>;
  setSyncStatus: (input: DksLocalSyncState | DksLocalSyncStatus) => Promise<DksLocalSyncState>;
  flushSync: () => Promise<DksLocalSyncState>;
  backupNow: () => Promise<DksLocalBackupResult>;
  close: () => Promise<DksLocalCloseResult>;
}

export interface DksWindowApi {
  platform: string;
  appVersion: string;
  minimizeToTray: () => void;
  quit: () => void;
  local?: DksLocalApi;
}

declare global {
  interface Window {
    dks?: DksWindowApi;
  }
}
