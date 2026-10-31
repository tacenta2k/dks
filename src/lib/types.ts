export type ThemePreference = 'light' | 'dark' | 'system';

export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

export type AppView = 'dashboard' | 'sheet';

export type DksLocalSyncStatus = 'offline' | 'syncing' | 'healthy' | 'error';

export interface DksLocalSyncState {
  status: DksLocalSyncStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingCount: number;
  /**
   * Cache-completeness evidence for cloud backup. Reported by the sync engine
   * after a fully successful authorized pull/reconcile, and compared by the
   * main process against the newest local mutation before it will snapshot.
   */
  lastPullAt?: string | null;
  lastPullComplete?: boolean;
  lastPullRows?: number | null;
  lastLocalMutationAt?: string | null;
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
  /** Authenticated profile's role; drives the Office visibility purge on apply. */
  role?: 'admin' | 'office' | string | null;
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
  /**
   * Local cache snapshot. The optional `role` is the authenticated profile's
   * role, validated in the main process exactly like every other role
   * parameter ('admin' | 'office'); 'office' reads are scoped to the 3-day
   * creation window, 'admin' reads are unfiltered.
   */
  getSnapshot: (input?: { role?: 'admin' | 'office' | string | null }) => Promise<DksLocalSnapshot>;
  /**
   * Office sign-in approval: push the current session clearance into the main
   * process ('office-pending' while an Office session awaits admin approval).
   * The object form `{ state, role }` also reports the signed-in profile's
   * role so Office reads can be scoped to the 3-day creation window.
   */
  setSessionClearance?: (
    state: 'office-pending' | 'allowed' | { state: 'office-pending' | 'allowed'; role?: 'admin' | 'office' | null },
  ) => Promise<'office-pending' | 'allowed'>;
  /** A successful data IPC call clears any stale local-store error banner. */
  onOperationSuccess?: (listener: () => void) => () => void;
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
  markOutboxTerminal?: (input: { id: number | string; message: string }) => Promise<{ ok: boolean }>;
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

export type DksUpdateErrorKind = 'check' | 'download';

export interface DksUpdateState {
  status: DksUpdateStatus;
  version?: string;
  /** Download completion 0–100 while downloading (when reported). */
  progress?: number;
  /** Distinguishes a failed release check from a failed installer download. */
  errorKind?: DksUpdateErrorKind;
  /** Real updater error detail — surfaces error.name/code/message from electron-updater (Bug 2). */
  errorMessage?: string;
  errorCode?: string;
  errorName?: string;
}

export interface DksUpdaterApi {
  checkForUpdates: () => Promise<DksUpdateState>;
  restartToUpdate: () => Promise<boolean>;
  onStatus: (listener: (state: DksUpdateState) => void) => () => void;
}

export type DksErrorReportCategory =
  | 'auth'
  | 'sync'
  | 'sqlite'
  | 'ipc'
  | 'updater'
  | 'renderer'
  | 'main'
  | 'settings'
  | 'network';

export type DksErrorReportSeverity = 'error' | 'warning';

export interface DksStructuredErrorReportInput {
  category: DksErrorReportCategory;
  severity: DksErrorReportSeverity;
  code: string;
  component: string;
  process?: 'main' | 'renderer';
  httpStatus?: number | null;
  postgresCode?: string | null;
  occurredAt?: string;
}

export interface DksSanitizedErrorReportEvent {
  fingerprint: string;
  category: DksErrorReportCategory;
  severity: DksErrorReportSeverity;
  code: string;
  component: string;
  process: 'main' | 'renderer';
  appVersion: string;
  platform: 'win32' | 'darwin' | 'linux' | 'unknown';
  arch: 'x64' | 'arm64' | 'ia32' | 'unknown';
  osRelease: string;
  electronVersion: string | null;
  packaged: boolean;
  sqliteSchemaVersion: number | null;
  httpStatus: number | null;
  postgresCode: string | null;
  occurrences: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
}

export interface DksErrorReportingStatusSummary {
  enabled: boolean;
  pendingCount: number;
  failedCount: number;
  suppressedCount: number;
  lastDeliveryOutcome:
    | 'never'
    | 'delivered'
    | 'suppressed_remote'
    | 'deferred_backoff'
    | 'rate_limited'
    | 'disabled'
    | 'failed';
  lastDeliveryAt: string | null;
}

export interface DksAdminLocalStatus {
  appVersion: string;
  packaged: boolean;
  platform: 'win32' | 'darwin' | 'linux' | 'unknown';
  arch: 'x64' | 'arm64' | 'ia32' | 'unknown';
  osRelease: string;
  electronVersion: string | null;
  localStore: {
    available: boolean;
    schemaVersion: number | null;
    failureCode: 'ABI_MISMATCH' | 'OPEN_FAILED' | null;
  };
  sync: {
    status: DksLocalSyncStatus | 'unknown';
    lastSyncAt: string | null;
    pendingOutboxCount: number;
    failedOutboxCount: number;
    terminalOutboxCount: number;
  };
  updater: {
    status: DksUpdateStatus;
    version: string | null;
    errorKind: DksUpdateErrorKind | null;
    errorCode: string | null;
  };
  errorReporting: DksErrorReportingStatusSummary;
}

export interface DksDiagnosticsApi {
  getAdminStatus: (input: { role: string }) => Promise<DksAdminLocalStatus>;
  captureError: (
    input: DksStructuredErrorReportInput,
  ) => Promise<{ accepted: boolean; reason?: string }>;
  claimErrorReports: (input: {
    role: string;
    limit?: number;
  }) => Promise<DksSanitizedErrorReportEvent[]>;
  completeErrorReport: (input: {
    role: string;
    fingerprint: string;
    outcome: 'delivered' | 'suppressed_remote' | 'disabled' | 'retry' | 'terminal';
    errorCode?: string | null;
    retryAfterSeconds?: number | null;
  }) => Promise<{ ok: boolean }>;
  setErrorReportingEnabled: (input: {
    role: string;
    enabled: boolean;
  }) => Promise<DksErrorReportingStatusSummary>;
  syncWorkspaceErrorReporting: (input: {
    role: string;
    enabled: boolean;
  }) => Promise<{ ok: boolean; enabled: boolean }>;
}

/**
 * Cloud-backup bridge (PR1). Mirrors the frozen preload API: the renderer gets
 * structured values only, never a file handle, a key or the Worker itself.
 */
export interface DksBackupApi {
  getState: (input: { role: string }) => Promise<DksBackupState>;
  runNow: (input: { role: string; trigger?: string }) => Promise<DksBackupRunResult>;
  list: (input: {
    role: string;
    year: number;
    month: number;
    cursor?: string | null;
  }) => Promise<DksBackupListResult>;
  download: (input: { role: string; objectKey: string }) => Promise<{
    filePath: string;
    sizeBytes: number;
    sha256: string;
  }>;
  testDrill: (input: { role: string; recoveryKey?: string }) => Promise<DksBackupDrillResult>;
  setupKey: (input: {
    role: string;
    action: 'generate' | 'confirm' | 'configure' | 'import';
    recoveryKey?: string;
    workerUrl?: string;
    enabled?: boolean;
    /** Only for 'import': the key id the pasted key must match. */
    keyId?: string;
  }) => Promise<DksBackupKeySetupResult>;
  healthCheck: (input: { role: string }) => Promise<DksBackupHealthResult>;
  /**
   * Pushes the signed-in session so main can authorise Worker calls.
   * Admin only in v1 — an Office session is refused here and by the Worker.
   */
  setSession: (input: {
    role: string;
    accessToken: string;
    workerUrl?: string;
  } | null) => Promise<{ ok: boolean }>;
  /**
   * Records the designated backup PC as read from Supabase `public.settings`.
   * A scheduling hint: the Worker re-reads the authoritative row per upload.
   */
  setDesignation: (input: {
    role: string;
    designation: DksBackupDesignation | null;
  }) => Promise<DksBackupState>;
  /** Renames this PC. A safe label only — never a hostname or user name. */
  setDeviceLabel: (input: { role: string; label: string }) => Promise<DksBackupState>;
}

export type DksBackupOutcome = 'verified' | 'pending' | 'failed' | 'no_changes' | 'incomplete';

/** The designated Admin backup PC, as stored in Supabase `public.settings`. */
export interface DksBackupDesignation {
  /** Opaque random device id (32 hex chars). Never a hostname or other PII. */
  deviceId: string;
  /** Administrator-chosen label. Must carry no PII. */
  label: string;
  designatedAt?: string | null;
}

export interface DksBackupState {
  enabled: boolean;
  keyConfigured: boolean;
  recoveryKeyStored: boolean;
  workerUrl: string | null;
  connection: 'not_configured' | 'signed_out' | 'offline' | 'ok' | 'error' | 'unknown';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastSuccessDate: string | null;
  lastFingerprint: string | null;
  lastSizeBytes: number | null;
  lastRecordCount: number | null;
  pendingUploads: number;
  nextCheckAt: string | null;
  lastOutcome: DksBackupOutcome | null;
  lastError: string | null;
  retentionDays: number;
  running: boolean;
  /** Public key identifier on this PC (SHA-256 prefix), or null. */
  keyId: string | null;
  /** What every backup from this build covers. Always 'local-cache' in PR1. */
  source: 'local-cache';
  /** This PC's opaque random device id (16 random bytes, hex). Never PII. */
  deviceId: string;
  /** Safe label for this PC. */
  deviceLabel: string;
  /** True when this PC is the designated Admin backup PC. */
  designated: boolean;
  /** The designated PC's id, or null when no PC is designated. */
  designatedDeviceId: string | null;
  /** The designated PC's label — shown when another PC holds the duty. */
  designatedDeviceLabel: string | null;
  designatedAt: string | null;
  /**
   * True only when a full authorized pull completed, walked every page, and no
   * local mutation happened after it. Backup refuses to snapshot without it.
   */
  cacheComplete: boolean;
}

export interface DksBackupRunResult {
  outcome: DksBackupOutcome;
  detail: string | null;
  sizeBytes: number | null;
  recordCount: number | null;
  objectKey: string | null;
  fingerprint: string | null;
}

export interface DksBackupHistoryEntry {
  day: string;
  sizeBytes: number | null;
  outcome: DksBackupOutcome;
  objectKey: string | null;
  createdAt: string | null;
  recordCount: number | null;
  /** Which key opens this backup; null when the object predates key ids. */
  keyId: string | null;
  /** What the snapshot covers. Always 'local-cache' in PR1. */
  source: string | null;
}

export interface DksBackupListResult {
  year: number;
  month: number;
  entries: DksBackupHistoryEntry[];
  nextCursor: string | null;
}

export interface DksBackupKeySetupResult {
  ok: boolean;
  recoveryKey?: string;
  /** Public key identifier after a successful generate/confirm/import. */
  keyId?: string;
  message: string;
}

export interface DksBackupDrillResult {
  ok: boolean;
  stage: 'download' | 'decrypt' | 'checksum' | 'integrity' | 'cleanup';
  sizeBytes: number | null;
  integrityCheck: string | null;
  message: string;
}

export interface DksBackupHealthResult {
  ok: boolean;
  reachable: boolean;
  r2Bound: boolean;
  detail: string | null;
}

export interface DksWindowApi {
  platform: string;
  appVersion: string;
  openExternal?: (url: string) => Promise<boolean>;
  minimizeToTray: () => void;
  quit: () => void;
  local?: DksLocalApi;
  diagnostics?: DksDiagnosticsApi;
  updater?: DksUpdaterApi;
  backup?: DksBackupApi;
}

declare global {
  interface Window {
    dks?: DksWindowApi;
  }
}
