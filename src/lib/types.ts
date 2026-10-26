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
  /** Soft-deleted columns, exposed so sync can push their deletion upstream. */
  deletedColumns?: DksLocalColumn[];
  settings?: Record<string, unknown>;
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

export interface DksLocalReorderColumnsInput {
  /** Active user column ids in their new display order. */
  columnIds: readonly string[];
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
  dismissed?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DksLocalNotificationUpdate {
  id: number | string;
  read?: boolean;
  dismissed?: boolean;
  payload?: Record<string, unknown>;
}

export interface DksLocalNotificationInput {
  type: string;
  message: string;
  payload: Record<string, unknown>;
  read?: boolean;
  dismissed?: boolean;
}

export interface DksLocalRemoteSnapshot {
  rows: readonly Record<string, unknown>[];
  columns: readonly Record<string, unknown>[];
}

export interface DksLocalCloseResult {
  closed: boolean;
  flushed: boolean;
}

/** Metadata for one queued local mutation; payloads stay in the main process. */
export interface DksLocalOutboxItem {
  id: number | string;
  idempotencyKey?: string;
  idempotency_key?: string;
  operation: string;
  entityType?: string;
  entity_type?: string;
  entityId?: string;
  entity_id?: string;
  status?: string;
  attempts?: number;
  lastError?: string | null;
  last_error?: string | null;
  createdAt?: string;
  created_at?: string;
}

export interface DksLocalApi {
  getSnapshot: () => Promise<DksLocalSnapshot>;
  /**
   * Office sign-in approval: push the current session clearance into the main
   * process ('office-pending' while an Office session awaits admin approval).
   */
  setSessionClearance?: (state: 'office-pending' | 'allowed') => Promise<'office-pending' | 'allowed'>;
  createRow: (input: DksLocalCreateRowInput) => Promise<DksLocalRow>;
  updateRow: (input: DksLocalUpdateRowInput) => Promise<DksLocalRow | null>;
  duplicateRow: (input: DksLocalRowCommand) => Promise<DksLocalRow | null>;
  softDeleteRow: (input: DksLocalRowCommand) => Promise<DksLocalRow | null>;
  restoreRow: (input: DksLocalRowCommand) => Promise<DksLocalRow | null>;
  permanentDeleteRow: (input: DksLocalRowCommand) => Promise<DksLocalRow | null>;
  addColumn: (input: DksLocalColumnInput) => Promise<DksLocalColumn>;
  updateColumn: (input: DksLocalUpdateColumnInput) => Promise<DksLocalColumn | null>;
  /** Atomic position-only reorder; optional like `rekeyColumn` for older bridges. */
  reorderColumns?: (input: DksLocalReorderColumnsInput) => Promise<DksLocalColumn[]>;
  deleteColumn: (input: DksLocalRowCommand & { role: string }) => Promise<DksLocalColumn | null>;
  rekeyColumn?: (input: { oldId: string; newId: string }) => Promise<{ ok: boolean }>;
  importRecords: (input: {
    records: readonly DksLocalImportRecord[];
    options?: DksLocalAuditOptions;
  }) => Promise<DksLocalRow[]>;
  listAudit: (input?: { limit?: number }) => Promise<DksLocalAuditRecord[]>;
  clearAuditLog?: (input: {
    message: string;
    role: string;
    actor?: string | null;
  }) => Promise<DksLocalAuditRecord>;
  listNotifications: (input?: { unreadOnly?: boolean }) => Promise<DksLocalNotificationRecord[]>;
  addNotification?: (input: DksLocalNotificationInput) => Promise<DksLocalNotificationRecord>;
  updateNotification?: (input: DksLocalNotificationUpdate) => Promise<DksLocalNotificationRecord | null>;
  applyRemoteSnapshot?: (input: DksLocalRemoteSnapshot) => Promise<DksLocalSnapshot>;
  acknowledgeOutbox?: () => Promise<DksLocalSyncState>;
  acknowledgeSettings?: () => Promise<DksLocalSyncState>;
  listOutbox?: (input?: { status?: string }) => Promise<DksLocalOutboxItem[]>;
  markOutboxSynced?: (input: { id: number | string }) => Promise<{ ok: boolean }>;
  markOutboxFailed?: (input: { id: number | string; message: string }) => Promise<{ ok: boolean }>;
  retryFailedOutbox?: () => Promise<{ requeued: number }>;
  getSettings?: () => Promise<Record<string, unknown>>;
  setSettings?: (input: { settings: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  setSyncStatus: (input: DksLocalSyncState | DksLocalSyncStatus) => Promise<DksLocalSyncState>;
  flushSync: () => Promise<DksLocalSyncState>;
  close: () => Promise<DksLocalCloseResult>;
}

/** Mirror of the main-process updater state (renderer-safe, serializable). */
export type DksUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'
  | 'disabled';

export interface DksUpdateState {
  status: DksUpdateStatus;
  version?: string;
  /** Download completion 0–100 while downloading (when reported). */
  progress?: number;
}

export interface DksUpdaterApi {
  checkForUpdates: () => Promise<DksUpdateState>;
  restartToUpdate: () => Promise<boolean>;
  onStatus: (listener: (state: DksUpdateState) => void) => () => void;
}

export interface DksWindowApi {
  platform: string;
  appVersion: string;
  openExternal?: (url: string) => Promise<boolean>;
  minimizeToTray: () => void;
  quit: () => void;
  local?: DksLocalApi;
  updater?: DksUpdaterApi;
}

declare global {
  interface Window {
    dks?: DksWindowApi;
  }
}
