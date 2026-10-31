import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import type {
  DksNotificationRequest,
  DksNotificationResult,
} from '../main/notifications';
import type { UpdateState } from '../main/updater';
import type { AdminLocalStatusSnapshot } from '../main/diagnostics-ipc';
import type {
  ErrorReportingStatusSummary,
  SanitizedErrorReportEvent,
  StructuredErrorReportInput,
} from '../main/error-reporter';
import type {
  BackupDrillResult,
  BackupHealthResult,
  BackupKeySetupResult,
  BackupListResult,
  BackupRunResult,
  BackupState,
} from '../main/backup-types';

export type DksNavigationTarget = 'dashboard' | 'sheet';

export type DksLocalSyncStatus = 'offline' | 'syncing' | 'healthy' | 'error';

export interface DksLocalSyncState {
  status: DksLocalSyncStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingCount: number;
}

export interface DksLocalRow {
  id: string;
  data: Record<string, unknown>;
  category?: string | null;
  deleted?: boolean;
  deletedAt?: string | null;
  deleted_at?: string | null;
  updatedAt?: string;
  updated_at?: string;
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
  updatedAt?: string;
  updated_at?: string;
}

export interface DksLocalSnapshot {
  rows: DksLocalRow[];
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
  role: string;
  idempotencyKey?: string;
}

export interface DksLocalUpdateColumnInput {
  id: string;
  patch: Record<string, unknown>;
  role: string;
  idempotencyKey?: string;
}

export interface DksLocalReorderColumnsInput {
  /** Active user column ids in their new display order. */
  columnIds: readonly string[];
  role: string;
  idempotencyKey?: string;
}

export interface DksLocalImportRecord {
  data: Record<string, unknown>;
  category?: string | null;
  sourceRowNumber?: number;
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

export interface DksLocalConflictInput {
  entityType: 'entry' | 'column';
  entityId: string;
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
  winner: 'local' | 'remote';
  createdAt?: string;
}

export interface DksLocalCloseResult {
  closed: boolean;
  flushed: boolean;
}

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
   * creation window, 'admin' reads are unfiltered. Absent keeps the legacy
   * unfiltered reads — there is no flag that widens the scope.
   */
  getSnapshot: (input?: { role?: 'admin' | 'office' | string | null }) => Promise<DksLocalSnapshot>;
  /**
   * Office sign-in approval: push the current session clearance
   * ('office-pending' while waiting for admin approval). The object form
   * additionally reports the signed-in profile's role so the local store can
   * scope Office reads to the 3-day window via the existing clearance
   * mechanism.
   */
  setSessionClearance: (
    state: 'office-pending' | 'allowed' | { state: 'office-pending' | 'allowed'; role?: 'admin' | 'office' | null },
  ) => Promise<'office-pending' | 'allowed'>;
  onOperationSuccess: (listener: () => void) => () => void;
  createRow: (input: DksLocalCreateRowInput) => Promise<DksLocalRow>;
  updateRow: (input: DksLocalUpdateRowInput) => Promise<DksLocalRow | null>;
  duplicateRow: (input: DksLocalRowCommand) => Promise<DksLocalRow | null>;
  softDeleteRow: (input: DksLocalRowCommand) => Promise<DksLocalRow | null>;
  restoreRow: (input: DksLocalRowCommand) => Promise<DksLocalRow | null>;
  permanentDeleteRow: (input: DksLocalRowCommand) => Promise<DksLocalRow | null>;
  addColumn: (input: DksLocalColumnInput) => Promise<DksLocalColumn>;
  updateColumn: (input: DksLocalUpdateColumnInput) => Promise<DksLocalColumn | null>;
  reorderColumns: (input: DksLocalReorderColumnsInput) => Promise<DksLocalColumn[]>;
  deleteColumn: (input: DksLocalRowCommand & { role: string }) => Promise<DksLocalColumn | null>;
  rekeyColumn: (input: { oldId: string; newId: string }) => Promise<{ ok: boolean }>;
  importRecords: (input: {
    records: readonly DksLocalImportRecord[];
    options?: Record<string, unknown>;
  }) => Promise<DksLocalRow[]>;
  listAudit: (input?: { limit?: number }) => Promise<DksLocalAuditRecord[]>;
  clearAuditLog: (input: { message: string; role: string; actor?: string | null }) => Promise<DksLocalAuditRecord>;
  listNotifications: (input?: { unreadOnly?: boolean }) => Promise<DksLocalNotificationRecord[]>;
  addNotification: (input: DksLocalNotificationInput) => Promise<DksLocalNotificationRecord>;
  updateNotification: (input: DksLocalNotificationUpdate) => Promise<DksLocalNotificationRecord | null>;
  applyRemoteSnapshot: (input: DksLocalRemoteSnapshot) => Promise<DksLocalSnapshot>;
  acknowledgeOutbox: () => Promise<DksLocalSyncState>;
  acknowledgeSettings?: () => Promise<DksLocalSyncState>;
  listOutbox?: (input?: { status?: string }) => Promise<DksLocalOutboxItem[]>;
  markOutboxSynced?: (input: { id: number | string }) => Promise<{ ok: boolean }>;
  markOutboxFailed?: (input: { id: number | string; message: string }) => Promise<{ ok: boolean }>;
  markOutboxTerminal?: (input: { id: number | string; message: string }) => Promise<{ ok: boolean }>;
  retryFailedOutbox?: () => Promise<{ requeued: number }>;
  recordConflict?: (input: DksLocalConflictInput) => Promise<unknown>;
  getSettings?: () => Promise<Record<string, unknown>>;
  setSettings?: (input: { settings: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  setSyncStatus: (input: DksLocalSyncState | DksLocalSyncStatus) => Promise<DksLocalSyncState>;
  flushSync: () => Promise<DksLocalSyncState>;
  close: () => Promise<DksLocalCloseResult>;
}

export interface DksDiagnosticsPreloadApi {
  readonly getAdminStatus: (input: { role: string }) => Promise<AdminLocalStatusSnapshot>;
  readonly captureError: (
    input: StructuredErrorReportInput,
  ) => Promise<{ accepted: boolean; reason?: string }>;
  readonly claimErrorReports: (input: {
    role: string;
    limit?: number;
  }) => Promise<SanitizedErrorReportEvent[]>;
  readonly completeErrorReport: (input: {
    role: string;
    fingerprint: string;
    outcome: 'delivered' | 'suppressed_remote' | 'disabled' | 'retry' | 'terminal';
    errorCode?: string | null;
    retryAfterSeconds?: number | null;
  }) => Promise<{ ok: boolean }>;
  readonly setErrorReportingEnabled: (input: {
    role: string;
    enabled: boolean;
  }) => Promise<ErrorReportingStatusSummary>;
  readonly syncWorkspaceErrorReporting: (input: {
    role: string;
    enabled: boolean;
  }) => Promise<{ ok: boolean; enabled: boolean }>;
}

/**
 * Cloud backup bridge (PR1).
 *
 * Every method requires the caller's role and is re-validated in the main
 * process; the renderer has no access to Node, `node:crypto`, the filesystem
 * or the backup Worker. Keys never cross this bridge except the recovery key,
 * which is returned exactly once by `setupKey({ action: 'generate' })`.
 */
export interface DksBackupPreloadApi {
  readonly getState: (input: { role: string }) => Promise<BackupState>;
  readonly runNow: (input: { role: string; trigger?: string }) => Promise<BackupRunResult>;
  readonly list: (input: {
    role: string;
    year: number;
    month: number;
    cursor?: string | null;
  }) => Promise<BackupListResult>;
  readonly download: (input: { role: string; objectKey: string }) => Promise<{
    filePath: string;
    sizeBytes: number;
    sha256: string;
  }>;
  readonly testDrill: (input: { role: string; recoveryKey?: string }) => Promise<BackupDrillResult>;
  readonly setupKey: (input: {
    role: string;
    action: 'generate' | 'confirm' | 'configure' | 'import';
    recoveryKey?: string;
    workerUrl?: string;
    enabled?: boolean;
    /** Only for 'import': the key id the pasted key must match. */
    keyId?: string;
  }) => Promise<BackupKeySetupResult>;
  readonly healthCheck: (input: { role: string }) => Promise<BackupHealthResult>;
  /**
   * Pushes the signed-in session so the main process can authorise Worker
   * calls. Pass `null` on sign-out. The Worker re-verifies this JWT itself.
   */
  readonly setSession: (input: {
    role: string;
    accessToken: string;
    workerUrl?: string;
  } | null) => Promise<{ ok: boolean }>;
}

export interface DksPreloadApi {
  readonly platform: string;
  readonly appVersion: string;
  readonly local: DksLocalApi;
  readonly diagnostics: DksDiagnosticsPreloadApi;
  readonly backup: DksBackupPreloadApi;
  readonly notifications: {
    show: (request: DksNotificationRequest) => Promise<DksNotificationResult>;
  };
  readonly updater: {
    checkForUpdates: () => Promise<UpdateState>;
    restartToUpdate: () => Promise<boolean>;
    onStatus: (listener: (state: UpdateState) => void) => () => void;
  };
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly minimizeToTray: () => void;
  readonly quit: () => void;
  readonly onLogoutRequested: (listener: () => void) => () => void;
  readonly onNavigationRequested: (
    listener: (target: DksNavigationTarget) => void,
  ) => () => void;
}

const APP_VERSION_CHANNEL = 'dks:app-version';
const MINIMIZE_TO_TRAY_CHANNEL = 'dks:minimize-to-tray';
const QUIT_CHANNEL = 'dks:quit';
const OPEN_EXTERNAL_CHANNEL = 'dks:open-external';
const LOGOUT_REQUESTED_CHANNEL = 'dks:logout-requested';
const NAVIGATION_REQUESTED_CHANNEL = 'dks:navigation-requested';
const NOTIFICATION_SHOW_CHANNEL = 'dks:notifications:show';
const UPDATER_CHECK_CHANNEL = 'dks:updater:check';
const UPDATER_RESTART_CHANNEL = 'dks:updater:restart';
const UPDATER_STATUS_CHANNEL = 'dks:updater:status';

const DIAGNOSTICS_CHANNELS = {
  getAdminStatus: 'dks:diagnostics:get-admin-status',
  captureError: 'dks:diagnostics:capture-error',
  claimErrorReports: 'dks:diagnostics:claim-error-reports',
  completeErrorReport: 'dks:diagnostics:complete-error-report',
  setErrorReportingEnabled: 'dks:diagnostics:set-error-reporting-enabled',
  syncWorkspaceErrorReporting: 'dks:diagnostics:sync-workspace-error-reporting',
} as const;

const BACKUP_CHANNELS = {
  getState: 'dks:backup:get-state',
  runNow: 'dks:backup:run-now',
  list: 'dks:backup:list',
  download: 'dks:backup:download',
  testDrill: 'dks:backup:test-drill',
  setupKey: 'dks:backup:setup-key',
  healthCheck: 'dks:backup:health-check',
  setSession: 'dks:backup:set-session',
} as const;

const LOCAL_CHANNELS = {
  getSnapshot: 'dks:local:get-snapshot',
  createRow: 'dks:local:create-row',
  updateRow: 'dks:local:update-row',
  duplicateRow: 'dks:local:duplicate-row',
  softDeleteRow: 'dks:local:soft-delete-row',
  restoreRow: 'dks:local:restore-row',
  permanentDeleteRow: 'dks:local:permanent-delete-row',
  addColumn: 'dks:local:add-column',
  updateColumn: 'dks:local:update-column',
  reorderColumns: 'dks:local:reorder-columns',
  deleteColumn: 'dks:local:delete-column',
  rekeyColumn: 'dks:local:rekey-column',
  importRecords: 'dks:local:import-records',
  listAudit: 'dks:local:list-audit',
  clearAuditLog: 'dks:local:clear-audit-log',
  listNotifications: 'dks:local:list-notifications',
  addNotification: 'dks:local:add-notification',
  updateNotification: 'dks:local:update-notification',
  applyRemoteSnapshot: 'dks:local:apply-remote-snapshot',
  acknowledgeOutbox: 'dks:local:acknowledge-outbox',
  acknowledgeSettings: 'dks:local:acknowledge-settings',
  listOutbox: 'dks:local:list-outbox',
  markOutboxSynced: 'dks:local:mark-outbox-synced',
  markOutboxFailed: 'dks:local:mark-outbox-failed',
  markOutboxTerminal: 'dks:local:mark-outbox-terminal',
  retryFailedOutbox: 'dks:local:retry-failed-outbox',
  recordConflict: 'dks:local:record-conflict',
  getSettings: 'dks:local:get-settings',
  setSettings: 'dks:local:set-settings',
  setSyncStatus: 'dks:local:set-sync-status',
  flushSync: 'dks:local:flush-sync',
  close: 'dks:local:close',
  setSessionClearance: 'dks:local:set-session-clearance',
} as const;

const LOCAL_SYNC_STATUSES: readonly DksLocalSyncStatus[] = [
  'offline',
  'syncing',
  'healthy',
  'error',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireId(value: unknown, label = 'id'): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} is required`);
  }
}

function requireData(value: unknown, label = 'data'): void {
  requireRecord(value, label);
}

function requireRole(value: unknown): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('role is required');
  }
}

function validateCreateRow(value: unknown): void {
  const input = requireRecord(value, 'create row input');
  requireData(input.data);
}

function validateUpdateRow(value: unknown): void {
  const input = requireRecord(value, 'update row input');
  requireId(input.id ?? input.rowId, 'row id');
  requireData(input.data ?? input.patch ?? {});
}

function validateRowCommand(value: unknown): void {
  const input = requireRecord(value, 'row command input');
  requireId(input.id ?? input.rowId, 'row id');
}

function validateAdminRowCommand(value: unknown): void {
  validateRowCommand(value);
  const input = requireRecord(value, 'row command input');
  requireRole(input.role);
  if (input.role !== 'admin') {
    throw new TypeError('administrator role is required');
  }
}

function validateAddColumn(value: unknown): void {
  const input = requireRecord(value, 'add column input');
  requireId(input.name, 'column name');
  requireId(input.type, 'column type');
  requireRole(input.role);
}

function validateUpdateColumn(value: unknown): void {
  const input = requireRecord(value, 'update column input');
  requireId(input.id ?? input.columnId, 'column id');
  requireRecord(input.patch, 'column patch');
  requireRole(input.role);
}

function validateReorderColumns(value: unknown): void {
  const input = requireRecord(value, 'reorder columns input');
  if (!Array.isArray(input.columnIds) || input.columnIds.length === 0) {
    throw new TypeError('columnIds must be a non-empty array');
  }
  if (input.columnIds.length > 1_000) {
    throw new TypeError('columnIds must contain at most 1000 columns');
  }
  const seen = new Set<string>();
  input.columnIds.forEach((columnId, index) => {
    requireId(columnId, `columnIds[${index}]`);
    const id = (columnId as string).trim();
    if (seen.has(id)) {
      throw new TypeError('columnIds must not contain duplicates');
    }
    seen.add(id);
  });
  requireRole(input.role);
}

function validateDeleteColumn(value: unknown): void {
  const input = requireRecord(value, 'delete column input');
  requireId(input.id ?? input.columnId, 'column id');
  requireRole(input.role);
}

function validateImport(value: unknown): void {
  const input = requireRecord(value, 'import records input');
  if (!Array.isArray(input.records)) {
    throw new TypeError('records must be an array');
  }
  input.records.forEach((record, index) => {
    const item = requireRecord(record, `records[${index}]`);
    requireData(item.data, `records[${index}].data`);
  });
  if (input.options !== undefined) {
    requireRecord(input.options, 'import options');
  }
}

function validateListAudit(value: unknown): void {
  if (value === undefined) return;
  const input = requireRecord(value, 'audit list input');
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 5_000)) {
    throw new TypeError('audit limit must be an integer between 1 and 5000');
  }
}

function validateListNotifications(value: unknown): void {
  if (value === undefined) return;
  const input = requireRecord(value, 'notification list input');
  if (input.unreadOnly !== undefined && typeof input.unreadOnly !== 'boolean') {
    throw new TypeError('unreadOnly must be a boolean');
  }
}

function validateUpdateNotification(value: unknown): void {
  const input = requireRecord(value, 'notification update input');
  const id = input.id ?? input.notificationId;
  if (!((typeof id === 'string' && id.trim().length > 0)
    || (typeof id === 'number' && Number.isSafeInteger(id)))) {
    throw new TypeError('notification id is required');
  }
  if (input.read !== undefined && typeof input.read !== 'boolean') {
    throw new TypeError('notification read must be a boolean');
  }
  if (input.dismissed !== undefined && typeof input.dismissed !== 'boolean') {
    throw new TypeError('notification dismissed must be a boolean');
  }
  if (input.payload !== undefined) {
    requireRecord(input.payload, 'notification payload');
  }
}

function validateAddNotification(value: unknown): void {
  const input = requireRecord(value, 'notification input');
  if (typeof input.type !== 'string' || input.type.trim().length === 0) {
    throw new TypeError('notification type is required');
  }
  if (typeof input.message !== 'string' || input.message.trim().length === 0) {
    throw new TypeError('notification message is required');
  }
  requireRecord(input.payload, 'notification payload');
  if (input.read !== undefined && typeof input.read !== 'boolean') {
    throw new TypeError('notification read must be a boolean');
  }
  if (input.dismissed !== undefined && typeof input.dismissed !== 'boolean') {
    throw new TypeError('notification dismissed must be a boolean');
  }
}

function validateOptionalRole(input: Record<string, unknown>, label: string): void {
  if (input.role !== undefined && input.role !== null && typeof input.role !== 'string') {
    throw new TypeError(`${label} role must be a string`);
  }
}

function validateRemoteSnapshot(value: unknown): void {
  const input = requireRecord(value, 'remote snapshot input');
  if (!Array.isArray(input.rows) || !Array.isArray(input.columns)) {
    throw new TypeError('remote snapshot rows and columns must be arrays');
  }
  validateOptionalRole(input, 'remote snapshot input');
  input.rows.forEach((row, index) => {
    const item = requireRecord(row, `remote rows[${index}]`);
    requireId(item.id, `remote rows[${index}].id`);
    requireData(item.data, `remote rows[${index}].data`);
  });
  input.columns.forEach((column, index) => {
    const item = requireRecord(column, `remote columns[${index}]`);
    requireId(item.id, `remote columns[${index}].id`);
    requireId(item.name, `remote columns[${index}].name`);
    requireId(item.type, `remote columns[${index}].type`);
  });
}

function validateScopeInput(value: unknown): void {
  if (value === undefined || value === null) return;
  const input = requireRecord(value, 'scope input');
  validateOptionalRole(input, 'scope input');
}

function validateSessionClearance(value: unknown): void {
  if (typeof value === 'string') {
    if (value !== 'office-pending' && value !== 'allowed') {
      throw new TypeError('session clearance state must be office-pending or allowed');
    }
    return;
  }
  const input = requireRecord(value, 'session clearance input');
  if (input.state !== 'office-pending' && input.state !== 'allowed') {
    throw new TypeError('session clearance state must be office-pending or allowed');
  }
  if (input.role !== undefined && input.role !== null && input.role !== 'admin' && input.role !== 'office') {
    throw new TypeError('session clearance role must be admin or office');
  }
}

function validateSettingsInput(value: unknown): void {
  const input = requireRecord(value, 'settings input');
  requireRecord(input.settings, 'settings');
}

function validateListOutbox(value: unknown): void {
  if (value === undefined) return;
  const input = requireRecord(value, 'outbox list input');
  if (input.status !== undefined && typeof input.status !== 'string') {
    throw new TypeError('outbox status must be a string');
  }
}

function validateMarkOutboxSynced(value: unknown): void {
  const input = requireRecord(value, 'outbox acknowledge input');
  const id = input.id;
  if (!((typeof id === 'string' && id.trim().length > 0)
    || (typeof id === 'number' && Number.isSafeInteger(id)))) {
    throw new TypeError('outbox id is required');
  }
}

function validateMarkOutboxFailed(value: unknown): void {
  const input = requireRecord(value, 'outbox failure input');
  validateMarkOutboxSynced(input);
  if (typeof input.message !== 'string' || input.message.trim().length === 0) {
    throw new TypeError('outbox failure message is required');
  }
}

function validateConflict(value: unknown): void {
  const input = requireRecord(value, 'conflict input');
  requireId(input.entityType, 'conflict entity type');
  requireId(input.entityId, 'conflict entity id');
  requireData(input.local, 'conflict local');
  requireData(input.remote, 'conflict remote');
  if (input.winner !== 'local' && input.winner !== 'remote') {
    throw new TypeError('conflict winner must be local or remote');
  }
}

function validateSyncStatus(value: unknown): void {
  if (typeof value === 'string') {
    if (!LOCAL_SYNC_STATUSES.includes(value as DksLocalSyncStatus)) {
      throw new TypeError('Invalid sync status');
    }
    return;
  }
  const input = requireRecord(value, 'sync status input');
  if (!LOCAL_SYNC_STATUSES.includes(input.status as DksLocalSyncStatus)) {
    throw new TypeError('Invalid sync status');
  }
  for (const [key, label] of [
    ['lastSyncAt', 'lastSyncAt'],
    ['last_sync_at', 'lastSyncAt'],
    ['lastError', 'lastError'],
    ['last_error', 'lastError'],
  ] as const) {
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string') {
      throw new TypeError(`${label} must be a string or null`);
    }
  }
  const pendingCount = input.pendingCount !== undefined ? input.pendingCount : input.pending_count;
  if (pendingCount !== undefined && (!Number.isInteger(pendingCount) || Number(pendingCount) < 0)) {
    throw new TypeError('pendingCount must be a non-negative integer');
  }
}

function cloneSerializable<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') {
    return value;
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

const localSuccessListeners = new Set<() => void>();

async function invokeLocal<T>(
  channel: string,
  payload: unknown,
  validate?: (value: unknown) => void,
): Promise<T> {
  try {
    validate?.(payload);
    const result = payload === undefined
      ? await ipcRenderer.invoke(channel)
      : await ipcRenderer.invoke(channel, payload);
    // A successful data operation proves that an earlier local-store error is
    // stale. Clearance changes and close do not prove the database is usable.
    if (channel !== LOCAL_CHANNELS.setSessionClearance && channel !== LOCAL_CHANNELS.close) {
      for (const listener of localSuccessListeners) {
        try { listener(); } catch { /* Observers cannot fail an IPC operation. */ }
      }
    }
    return cloneSerializable(result) as T;
  } catch (caught) {
    // Preserve a useful, bounded error while preventing a renderer caller from
    // receiving an arbitrary thrown value from the main process. R7: the local
    // store failure message carries the reason, the channel and the log path,
    // so the cap has to stay above that (~300 chars) or the path is cut off.
    const message = caught instanceof Error && caught.message.trim()
      ? caught.message.trim().slice(0, 400)
      : 'Local operation failed';
    throw new Error(message);
  }
}

const localApi: DksLocalApi = Object.freeze({
  getSnapshot: (input?: { role?: 'admin' | 'office' | string | null }) =>
    invokeLocal<DksLocalSnapshot>(LOCAL_CHANNELS.getSnapshot, input, validateScopeInput),
  onOperationSuccess: (listener: () => void) => {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    localSuccessListeners.add(listener);
    return () => { localSuccessListeners.delete(listener); };
  },
  createRow: (input: DksLocalCreateRowInput) => invokeLocal<DksLocalRow>(LOCAL_CHANNELS.createRow, input, validateCreateRow),
  updateRow: (input: DksLocalUpdateRowInput) => invokeLocal<DksLocalRow | null>(LOCAL_CHANNELS.updateRow, input, validateUpdateRow),
  duplicateRow: (input: DksLocalRowCommand) => invokeLocal<DksLocalRow | null>(LOCAL_CHANNELS.duplicateRow, input, validateRowCommand),
  softDeleteRow: (input: DksLocalRowCommand) => invokeLocal<DksLocalRow | null>(LOCAL_CHANNELS.softDeleteRow, input, validateRowCommand),
  restoreRow: (input: DksLocalRowCommand) => invokeLocal<DksLocalRow | null>(LOCAL_CHANNELS.restoreRow, input, validateAdminRowCommand),
  permanentDeleteRow: (input: DksLocalRowCommand) => invokeLocal<DksLocalRow | null>(LOCAL_CHANNELS.permanentDeleteRow, input, validateAdminRowCommand),
  addColumn: (input: DksLocalColumnInput) => invokeLocal<DksLocalColumn>(LOCAL_CHANNELS.addColumn, input, validateAddColumn),
  updateColumn: (input: DksLocalUpdateColumnInput) => invokeLocal<DksLocalColumn | null>(LOCAL_CHANNELS.updateColumn, input, validateUpdateColumn),
  reorderColumns: (input: DksLocalReorderColumnsInput) => invokeLocal<DksLocalColumn[]>(LOCAL_CHANNELS.reorderColumns, input, validateReorderColumns),
  deleteColumn: (input: DksLocalRowCommand & { role: string }) => invokeLocal<DksLocalColumn | null>(LOCAL_CHANNELS.deleteColumn, input, validateDeleteColumn),
  rekeyColumn: (input: { oldId: string; newId: string }) => invokeLocal<{ ok: boolean }>(LOCAL_CHANNELS.rekeyColumn, input, (payload) => {
    const record = payload as Record<string, unknown>;
    if (typeof record?.oldId !== 'string' || !record.oldId.trim()) {
      throw new Error('old column id must be a non-empty string');
    }
    if (typeof record?.newId !== 'string' || !record.newId.trim()) {
      throw new Error('new column id must be a non-empty string');
    }
  }),
  importRecords: (input: { records: readonly DksLocalImportRecord[]; options?: Record<string, unknown> }) => invokeLocal<DksLocalRow[]>(LOCAL_CHANNELS.importRecords, input, validateImport),
  listAudit: (input: { limit?: number } = {}) => invokeLocal<DksLocalAuditRecord[]>(LOCAL_CHANNELS.listAudit, input, validateListAudit),
  clearAuditLog: (input: { message: string; role: string; actor?: string | null }) => invokeLocal<DksLocalAuditRecord>(LOCAL_CHANNELS.clearAuditLog, input, (payload) => {
    const record = payload as Record<string, unknown>;
    if (!record || typeof record.message !== 'string') {
      throw new Error('Audit clear message must be a string');
    }
    if (typeof record.role !== 'string') {
      throw new Error('Audit clear role must be a string');
    }
  }),
  listNotifications: (input: { unreadOnly?: boolean } = {}) => invokeLocal<DksLocalNotificationRecord[]>(LOCAL_CHANNELS.listNotifications, input, validateListNotifications),
  addNotification: (input: DksLocalNotificationInput) => invokeLocal<DksLocalNotificationRecord>(LOCAL_CHANNELS.addNotification, input, validateAddNotification),
  updateNotification: (input: DksLocalNotificationUpdate) => invokeLocal<DksLocalNotificationRecord | null>(LOCAL_CHANNELS.updateNotification, input, validateUpdateNotification),
  applyRemoteSnapshot: (input: DksLocalRemoteSnapshot) => invokeLocal<DksLocalSnapshot>(LOCAL_CHANNELS.applyRemoteSnapshot, input, validateRemoteSnapshot),
  acknowledgeOutbox: () => invokeLocal<DksLocalSyncState>(LOCAL_CHANNELS.acknowledgeOutbox, undefined),
  acknowledgeSettings: () => invokeLocal<DksLocalSyncState>(LOCAL_CHANNELS.acknowledgeSettings, undefined),
  listOutbox: (input: { status?: string } = {}) => invokeLocal<DksLocalOutboxItem[]>(LOCAL_CHANNELS.listOutbox, input, validateListOutbox),
  markOutboxSynced: (input: { id: number | string }) => invokeLocal<{ ok: boolean }>(LOCAL_CHANNELS.markOutboxSynced, input, validateMarkOutboxSynced),
  markOutboxFailed: (input: { id: number | string; message: string }) => invokeLocal<{ ok: boolean }>(LOCAL_CHANNELS.markOutboxFailed, input, validateMarkOutboxFailed),
  markOutboxTerminal: (input: { id: number | string; message: string }) => invokeLocal<{ ok: boolean }>(LOCAL_CHANNELS.markOutboxTerminal, input, validateMarkOutboxFailed),
  retryFailedOutbox: () => invokeLocal<{ requeued: number }>(LOCAL_CHANNELS.retryFailedOutbox, undefined),
  recordConflict: (input: DksLocalConflictInput) => invokeLocal<unknown>(LOCAL_CHANNELS.recordConflict, input, validateConflict),
  getSettings: () => invokeLocal<Record<string, unknown>>(LOCAL_CHANNELS.getSettings, undefined),
  setSettings: (input: { settings: Record<string, unknown> }) => invokeLocal<Record<string, unknown>>(LOCAL_CHANNELS.setSettings, input, validateSettingsInput),
  setSyncStatus: (input: DksLocalSyncState | DksLocalSyncStatus) => invokeLocal<DksLocalSyncState>(LOCAL_CHANNELS.setSyncStatus, input, validateSyncStatus),
  flushSync: () => invokeLocal<DksLocalSyncState>(LOCAL_CHANNELS.flushSync, undefined),
  close: () => invokeLocal<DksLocalCloseResult>(LOCAL_CHANNELS.close, undefined),
  /**
   * Office sign-in approval: 'office-pending' while an Office session awaits
   * admin approval (customer-data channels refuse in the main process);
   * 'allowed' for Admin/demo/sign-out. The object form `{ state, role }` also
   * reports the signed-in profile's role (existing clearance mechanism).
   */
  setSessionClearance: (
    state: 'office-pending' | 'allowed' | { state: 'office-pending' | 'allowed'; role?: 'admin' | 'office' | null },
  ) => invokeLocal<'office-pending' | 'allowed'>(LOCAL_CHANNELS.setSessionClearance, state, validateSessionClearance),
});

function getAppVersion(): string {
  try {
    const version = ipcRenderer.sendSync(APP_VERSION_CHANNEL);
    return typeof version === 'string' && version.trim() ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function normaliseUpdateState(value: unknown): UpdateState {
  if (typeof value !== 'object' || value === null) {
    return { status: 'error' };
  }

  const record = value as {
    status?: unknown;
    version?: unknown;
    progress?: unknown;
    errorKind?: unknown;
    errorMessage?: unknown;
    errorCode?: unknown;
    errorName?: unknown;
  };
  const statuses: UpdateState['status'][] = [
    'idle',
    'checking',
    'available',
    'downloading',
    'downloaded',
    'not-available',
    'error',
    'disabled',
  ];

  if (typeof record.status !== 'string' || !statuses.includes(record.status as UpdateState['status'])) {
    return { status: 'error' };
  }

  const state: UpdateState = { status: record.status as UpdateState['status'] };
  if (typeof record.version === 'string' && record.version.trim()) {
    state.version = record.version;
  }
  if (typeof record.progress === 'number' && Number.isFinite(record.progress)) {
    state.progress = Math.max(0, Math.min(100, Math.round(record.progress)));
  }
  if (state.status === 'error' && (record.errorKind === 'check' || record.errorKind === 'download')) {
    state.errorKind = record.errorKind;
  }
  if (typeof record.errorMessage === 'string' && record.errorMessage.trim()) {
    state.errorMessage = record.errorMessage.trim().slice(0, 500);
  }
  if (typeof record.errorCode === 'string' && record.errorCode.trim()) {
    state.errorCode = record.errorCode.trim().slice(0, 100);
  }
  if (typeof record.errorName === 'string' && record.errorName.trim()) {
    state.errorName = record.errorName.trim().slice(0, 100);
  }
  return state;
}

function normaliseNotificationResult(value: unknown): DksNotificationResult {
  if (typeof value !== 'object' || value === null) {
    return { delivered: false, reason: 'unavailable' };
  }

  const record = value as { delivered?: unknown; reason?: unknown };
  if (record.delivered === true) {
    return { delivered: true };
  }

  const reasons = [
    'invalid',
    'unsupported',
    'unavailable',
    'error',
  ] as const;

  const reason = typeof record.reason === 'string' && reasons.includes(record.reason as (typeof reasons)[number])
    ? (record.reason as (typeof reasons)[number])
    : 'unavailable';

  return { delivered: false, reason };
}

function subscribeToLogout(listener: () => void): () => void {
  if (typeof listener !== 'function') {
    return () => undefined;
  }

  const handler = (_event: IpcRendererEvent) => {
    try {
      listener();
    } catch {
      // Renderer listeners are isolated from the preload bridge.
    }
  };

  ipcRenderer.on(LOGOUT_REQUESTED_CHANNEL, handler);
  return () => {
    try {
      ipcRenderer.removeListener(LOGOUT_REQUESTED_CHANNEL, handler);
    } catch {
      // The renderer may be tearing down at the same time.
    }
  };
}

function subscribeToNavigation(listener: (target: DksNavigationTarget) => void): () => void {
  if (typeof listener !== 'function') {
    return () => undefined;
  }

  const handler = (_event: IpcRendererEvent, value: unknown) => {
    if (value !== 'dashboard' && value !== 'sheet') {
      return;
    }

    try {
      listener(value);
    } catch {
      // Renderer listeners are isolated from the preload bridge.
    }
  };

  ipcRenderer.on(NAVIGATION_REQUESTED_CHANNEL, handler);
  return () => {
    try {
      ipcRenderer.removeListener(NAVIGATION_REQUESTED_CHANNEL, handler);
    } catch {
      // The renderer may be tearing down at the same time.
    }
  };
}

function subscribeToUpdateStatus(listener: (state: UpdateState) => void): () => void {
  if (typeof listener !== 'function') {
    return () => undefined;
  }

  const handler = (_event: IpcRendererEvent, value: unknown) => {
    try {
      listener(normaliseUpdateState(value));
    } catch {
      // Renderer listeners are isolated from the preload bridge.
    }
  };

  ipcRenderer.on(UPDATER_STATUS_CHANNEL, handler);
  return () => {
    try {
      ipcRenderer.removeListener(UPDATER_STATUS_CHANNEL, handler);
    } catch {
      // The renderer may be tearing down at the same time.
    }
  };
}

const notificationApi = Object.freeze({
  show: async (request: DksNotificationRequest): Promise<DksNotificationResult> => {
    try {
      const result = await ipcRenderer.invoke(NOTIFICATION_SHOW_CHANNEL, request);
      return normaliseNotificationResult(result);
    } catch {
      return { delivered: false, reason: 'unavailable' };
    }
  },
});

const updaterApi = Object.freeze({
  checkForUpdates: async (): Promise<UpdateState> => {
    try {
      return normaliseUpdateState(await ipcRenderer.invoke(UPDATER_CHECK_CHANNEL));
    } catch {
      return { status: 'error' };
    }
  },
  restartToUpdate: async (): Promise<boolean> => {
    try {
      return (await ipcRenderer.invoke(UPDATER_RESTART_CHANNEL)) === true;
    } catch {
      return false;
    }
  },
  onStatus: subscribeToUpdateStatus,
});

async function invokeDiagnostics<T>(
  channel: string,
  payload: unknown,
  validate?: (value: unknown) => void,
): Promise<T> {
  if (validate) {
    validate(payload);
  }
  try {
    const result = await ipcRenderer.invoke(channel, payload);
    return cloneSerializable(result) as T;
  } catch (caught) {
    const message = caught instanceof Error && caught.message.trim()
      ? caught.message.trim().slice(0, 400)
      : 'Diagnostics operation failed';
    throw new Error(message);
  }
}

function validateAdminDiagnosticsInput(value: unknown): void {
  const input = requireRecord(value, 'diagnostics input');
  requireRole(input.role);
  if (input.role !== 'admin') {
    throw new TypeError('administrator role is required');
  }
}

function validateClearedDiagnosticsInput(value: unknown): void {
  const input = requireRecord(value, 'diagnostics input');
  requireRole(input.role);
  if (input.role !== 'admin' && input.role !== 'office') {
    throw new TypeError('authenticated session role is required');
  }
}

const diagnosticsApi: DksDiagnosticsPreloadApi = Object.freeze({
  getAdminStatus: (input: { role: string }) =>
    invokeDiagnostics<AdminLocalStatusSnapshot>(
      DIAGNOSTICS_CHANNELS.getAdminStatus,
      input,
      validateAdminDiagnosticsInput,
    ),
  captureError: async (input: StructuredErrorReportInput): Promise<{ accepted: boolean; reason?: string }> => {
    try {
      const record = requireRecord(input, 'error report input');
      const result = await ipcRenderer.invoke(DIAGNOSTICS_CHANNELS.captureError, record);
      if (isRecord(result) && typeof result.accepted === 'boolean') {
        return {
          accepted: result.accepted,
          ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
        };
      }
      return { accepted: false, reason: 'unavailable' };
    } catch {
      return { accepted: false, reason: 'ipc_error' };
    }
  },
  claimErrorReports: (input: { role: string; limit?: number }) =>
    invokeDiagnostics<SanitizedErrorReportEvent[]>(
      DIAGNOSTICS_CHANNELS.claimErrorReports,
      input,
      (payload) => {
        validateClearedDiagnosticsInput(payload);
        const record = payload as Record<string, unknown>;
        if (
          record.limit !== undefined
          && (typeof record.limit !== 'number' || !Number.isInteger(record.limit) || record.limit < 1 || record.limit > 5)
        ) {
          throw new TypeError('limit must be an integer between 1 and 5');
        }
      },
    ),
  completeErrorReport: (input: {
    role: string;
    fingerprint: string;
    outcome: 'delivered' | 'suppressed_remote' | 'disabled' | 'retry' | 'terminal';
    errorCode?: string | null;
    retryAfterSeconds?: number | null;
  }) =>
    invokeDiagnostics<{ ok: boolean }>(
      DIAGNOSTICS_CHANNELS.completeErrorReport,
      input,
      (payload) => {
        validateClearedDiagnosticsInput(payload);
        const record = payload as Record<string, unknown>;
        if (typeof record.fingerprint !== 'string' || !/^[0-9a-f]{32}$/.test(record.fingerprint)) {
          throw new TypeError('valid report fingerprint is required');
        }
        if (typeof record.outcome !== 'string') {
          throw new TypeError('delivery outcome is required');
        }
      },
    ),
  setErrorReportingEnabled: (input: { role: string; enabled: boolean }) =>
    invokeDiagnostics<ErrorReportingStatusSummary>(
      DIAGNOSTICS_CHANNELS.setErrorReportingEnabled,
      input,
      (payload) => {
        validateAdminDiagnosticsInput(payload);
        const record = payload as Record<string, unknown>;
        if (typeof record.enabled !== 'boolean') {
          throw new TypeError('enabled must be a boolean');
        }
      },
    ),
  syncWorkspaceErrorReporting: (input: { role: string; enabled: boolean }) =>
    invokeDiagnostics<{ ok: boolean; enabled: boolean }>(
      DIAGNOSTICS_CHANNELS.syncWorkspaceErrorReporting,
      input,
      (payload) => {
        validateClearedDiagnosticsInput(payload);
        const record = payload as Record<string, unknown>;
        if (typeof record.enabled !== 'boolean') {
          throw new TypeError('enabled must be a boolean');
        }
      },
    ),
});

async function invokeBackup<T>(
  channel: string,
  payload: unknown,
  validate: (value: unknown) => void,
): Promise<T> {
  validate(payload);
  try {
    const result = await ipcRenderer.invoke(channel, payload);
    return cloneSerializable(result) as T;
  } catch (caught) {
    const message = caught instanceof Error && caught.message.trim()
      ? caught.message.trim().slice(0, 400)
      : 'The backup operation failed';
    throw new Error(message);
  }
}

function validateAdminBackupInput(value: unknown): void {
  const input = requireRecord(value, 'backup input');
  requireRole(input.role);
  if (input.role !== 'admin') {
    throw new TypeError('administrator role is required');
  }
}

function validateBackupListInput(value: unknown): void {
  validateAdminBackupInput(value);
  const input = value as Record<string, unknown>;
  if (typeof input.year !== 'number' || !Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) {
    throw new TypeError('a valid year is required');
  }
  if (typeof input.month !== 'number' || !Number.isInteger(input.month) || input.month < 1 || input.month > 12) {
    throw new TypeError('a valid month is required');
  }
  if (input.cursor !== undefined && input.cursor !== null && typeof input.cursor !== 'string') {
    throw new TypeError('cursor must be a string');
  }
}

function validateBackupDownloadInput(value: unknown): void {
  validateAdminBackupInput(value);
  requireId((value as Record<string, unknown>).objectKey, 'objectKey');
}

function validateBackupSetupInput(value: unknown): void {
  validateAdminBackupInput(value);
  const input = value as Record<string, unknown>;
  if (
    input.action !== 'generate'
    && input.action !== 'confirm'
    && input.action !== 'configure'
    && input.action !== 'import'
  ) {
    throw new TypeError("action must be 'generate', 'confirm', 'configure' or 'import'");
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new TypeError('enabled must be a boolean');
  }
  if (input.recoveryKey !== undefined && typeof input.recoveryKey !== 'string') {
    throw new TypeError('recoveryKey must be a string');
  }
  if (input.workerUrl !== undefined && typeof input.workerUrl !== 'string') {
    throw new TypeError('workerUrl must be a string');
  }
  if (input.keyId !== undefined && !/^[0-9a-f]{24}$/i.test(String(input.keyId))) {
    throw new TypeError('keyId must be a 24-character hex key identifier');
  }
}

const backupApi: DksBackupPreloadApi = Object.freeze({
  getState: (input: { role: string }) =>
    invokeBackup<BackupState>(BACKUP_CHANNELS.getState, input, validateAdminBackupInput),
  runNow: (input: { role: string; trigger?: string }) =>
    invokeBackup<BackupRunResult>(BACKUP_CHANNELS.runNow, input, validateAdminBackupInput),
  list: (input: { role: string; year: number; month: number; cursor?: string | null }) =>
    invokeBackup<BackupListResult>(BACKUP_CHANNELS.list, input, validateBackupListInput),
  download: (input: { role: string; objectKey: string }) =>
    invokeBackup<{ filePath: string; sizeBytes: number; sha256: string }>(
      BACKUP_CHANNELS.download,
      input,
      validateBackupDownloadInput,
    ),
  testDrill: (input: { role: string; recoveryKey?: string }) =>
    invokeBackup<BackupDrillResult>(BACKUP_CHANNELS.testDrill, input, validateAdminBackupInput),
  setupKey: (input: {
    role: string;
    action: 'generate' | 'confirm' | 'configure' | 'import';
    recoveryKey?: string;
    workerUrl?: string;
    enabled?: boolean;
    /** Only for 'import': the key id the pasted key must match. */
    keyId?: string;
  }) =>
    invokeBackup<BackupKeySetupResult>(BACKUP_CHANNELS.setupKey, input, validateBackupSetupInput),
  healthCheck: (input: { role: string }) =>
    invokeBackup<BackupHealthResult>(BACKUP_CHANNELS.healthCheck, input, validateAdminBackupInput),
  setSession: async (input: { role: string; accessToken: string; workerUrl?: string } | null) => {
    if (input === null) {
      try {
        await ipcRenderer.invoke(BACKUP_CHANNELS.setSession, null);
      } catch {
        // The main process may already be shutting down.
      }
      return { ok: true };
    }
    try {
      const record = requireRecord(input, 'backup session');
      requireRole(record.role);
      if (record.role !== 'admin' && record.role !== 'office') {
        throw new TypeError('authenticated session role is required');
      }
      if (typeof record.accessToken !== 'string' || record.accessToken.trim().length === 0) {
        throw new TypeError('accessToken is required');
      }
      if (record.workerUrl !== undefined && typeof record.workerUrl !== 'string') {
        throw new TypeError('workerUrl must be a string');
      }
      const result = await ipcRenderer.invoke(BACKUP_CHANNELS.setSession, record);
      return { ok: isRecord(result) && result.ok === true };
    } catch {
      return { ok: false };
    }
  },
});

const dksApi: DksPreloadApi = Object.freeze({
  platform: typeof process === 'undefined' ? 'unknown' : process.platform,
  appVersion: getAppVersion(),
  local: localApi,
  diagnostics: diagnosticsApi,
  backup: backupApi,
  notifications: notificationApi,
  updater: updaterApi,
  openExternal: async (url: string): Promise<boolean> => {
    try {
      return (await ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url)) === true;
    } catch {
      return false;
    }
  },
  minimizeToTray: () => {
    try {
      ipcRenderer.send(MINIMIZE_TO_TRAY_CHANNEL);
    } catch {
      // The main process may already be shutting down.
    }
  },
  quit: () => {
    try {
      ipcRenderer.send(QUIT_CHANNEL);
    } catch {
      // The main process may already be shutting down.
    }
  },
  onLogoutRequested: subscribeToLogout,
  onNavigationRequested: subscribeToNavigation,
});

contextBridge.exposeInMainWorld('dks', dksApi);

export { dksApi };
