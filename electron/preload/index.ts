import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import type {
  DksNotificationRequest,
  DksNotificationResult,
} from '../main/notifications';
import type { UpdateState } from '../main/updater';

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
    options?: Record<string, unknown>;
  }) => Promise<DksLocalRow[]>;
  listAudit: (input?: { limit?: number }) => Promise<DksLocalAuditRecord[]>;
  listNotifications: (input?: { unreadOnly?: boolean }) => Promise<DksLocalNotificationRecord[]>;
  addNotification: (input: DksLocalNotificationInput) => Promise<DksLocalNotificationRecord>;
  updateNotification: (input: DksLocalNotificationUpdate) => Promise<DksLocalNotificationRecord | null>;
  applyRemoteSnapshot: (input: DksLocalRemoteSnapshot) => Promise<DksLocalSnapshot>;
  acknowledgeOutbox: () => Promise<DksLocalSyncState>;
  setSyncStatus: (input: DksLocalSyncState | DksLocalSyncStatus) => Promise<DksLocalSyncState>;
  flushSync: () => Promise<DksLocalSyncState>;
  close: () => Promise<DksLocalCloseResult>;
}

export interface DksPreloadApi {
  readonly platform: string;
  readonly appVersion: string;
  readonly local: DksLocalApi;
  readonly notifications: {
    show: (request: DksNotificationRequest) => Promise<DksNotificationResult>;
  };
  readonly updater: {
    checkForUpdates: () => Promise<UpdateState>;
    restartToUpdate: () => Promise<boolean>;
    onStatus: (listener: (state: UpdateState) => void) => () => void;
  };
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
const LOGOUT_REQUESTED_CHANNEL = 'dks:logout-requested';
const NAVIGATION_REQUESTED_CHANNEL = 'dks:navigation-requested';
const NOTIFICATION_SHOW_CHANNEL = 'dks:notifications:show';
const UPDATER_CHECK_CHANNEL = 'dks:updater:check';
const UPDATER_RESTART_CHANNEL = 'dks:updater:restart';
const UPDATER_STATUS_CHANNEL = 'dks:updater:status';

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
  deleteColumn: 'dks:local:delete-column',
  importRecords: 'dks:local:import-records',
  listAudit: 'dks:local:list-audit',
  listNotifications: 'dks:local:list-notifications',
  addNotification: 'dks:local:add-notification',
  updateNotification: 'dks:local:update-notification',
  applyRemoteSnapshot: 'dks:local:apply-remote-snapshot',
  acknowledgeOutbox: 'dks:local:acknowledge-outbox',
  setSyncStatus: 'dks:local:set-sync-status',
  flushSync: 'dks:local:flush-sync',
  close: 'dks:local:close',
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

function validateRemoteSnapshot(value: unknown): void {
  const input = requireRecord(value, 'remote snapshot input');
  if (!Array.isArray(input.rows) || !Array.isArray(input.columns)) {
    throw new TypeError('remote snapshot rows and columns must be arrays');
  }
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
    return cloneSerializable(result) as T;
  } catch (caught) {
    // Preserve a useful, bounded error while preventing a renderer caller from
    // receiving an arbitrary thrown value from the main process.
    const message = caught instanceof Error && caught.message.trim()
      ? caught.message.trim().slice(0, 240)
      : 'Local operation failed';
    throw new Error(message);
  }
}

const localApi: DksLocalApi = Object.freeze({
  getSnapshot: () => invokeLocal<DksLocalSnapshot>(LOCAL_CHANNELS.getSnapshot, undefined),
  createRow: (input: DksLocalCreateRowInput) => invokeLocal<DksLocalRow>(LOCAL_CHANNELS.createRow, input, validateCreateRow),
  updateRow: (input: DksLocalUpdateRowInput) => invokeLocal<DksLocalRow | null>(LOCAL_CHANNELS.updateRow, input, validateUpdateRow),
  duplicateRow: (input: DksLocalRowCommand) => invokeLocal<DksLocalRow | null>(LOCAL_CHANNELS.duplicateRow, input, validateRowCommand),
  softDeleteRow: (input: DksLocalRowCommand) => invokeLocal<DksLocalRow | null>(LOCAL_CHANNELS.softDeleteRow, input, validateRowCommand),
  restoreRow: (input: DksLocalRowCommand) => invokeLocal<DksLocalRow | null>(LOCAL_CHANNELS.restoreRow, input, validateAdminRowCommand),
  permanentDeleteRow: (input: DksLocalRowCommand) => invokeLocal<DksLocalRow | null>(LOCAL_CHANNELS.permanentDeleteRow, input, validateAdminRowCommand),
  addColumn: (input: DksLocalColumnInput) => invokeLocal<DksLocalColumn>(LOCAL_CHANNELS.addColumn, input, validateAddColumn),
  updateColumn: (input: DksLocalUpdateColumnInput) => invokeLocal<DksLocalColumn | null>(LOCAL_CHANNELS.updateColumn, input, validateUpdateColumn),
  deleteColumn: (input: DksLocalRowCommand & { role: string }) => invokeLocal<DksLocalColumn | null>(LOCAL_CHANNELS.deleteColumn, input, validateDeleteColumn),
  importRecords: (input: { records: readonly DksLocalImportRecord[]; options?: Record<string, unknown> }) => invokeLocal<DksLocalRow[]>(LOCAL_CHANNELS.importRecords, input, validateImport),
  listAudit: (input: { limit?: number } = {}) => invokeLocal<DksLocalAuditRecord[]>(LOCAL_CHANNELS.listAudit, input, validateListAudit),
  listNotifications: (input: { unreadOnly?: boolean } = {}) => invokeLocal<DksLocalNotificationRecord[]>(LOCAL_CHANNELS.listNotifications, input, validateListNotifications),
  addNotification: (input: DksLocalNotificationInput) => invokeLocal<DksLocalNotificationRecord>(LOCAL_CHANNELS.addNotification, input, validateAddNotification),
  updateNotification: (input: DksLocalNotificationUpdate) => invokeLocal<DksLocalNotificationRecord | null>(LOCAL_CHANNELS.updateNotification, input, validateUpdateNotification),
  applyRemoteSnapshot: (input: DksLocalRemoteSnapshot) => invokeLocal<DksLocalSnapshot>(LOCAL_CHANNELS.applyRemoteSnapshot, input, validateRemoteSnapshot),
  acknowledgeOutbox: () => invokeLocal<DksLocalSyncState>(LOCAL_CHANNELS.acknowledgeOutbox, undefined),
  setSyncStatus: (input: DksLocalSyncState | DksLocalSyncStatus) => invokeLocal<DksLocalSyncState>(LOCAL_CHANNELS.setSyncStatus, input, validateSyncStatus),
  flushSync: () => invokeLocal<DksLocalSyncState>(LOCAL_CHANNELS.flushSync, undefined),
  close: () => invokeLocal<DksLocalCloseResult>(LOCAL_CHANNELS.close, undefined),
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

  const record = value as { status?: unknown; version?: unknown };
  const statuses: UpdateState['status'][] = [
    'idle',
    'checking',
    'available',
    'downloading',
    'downloaded',
    'not-available',
    'error',
  ];

  if (typeof record.status !== 'string' || !statuses.includes(record.status as UpdateState['status'])) {
    return { status: 'error' };
  }

  return typeof record.version === 'string' && record.version.trim()
    ? { status: record.status as UpdateState['status'], version: record.version }
    : { status: record.status as UpdateState['status'] };
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

const dksApi: DksPreloadApi = Object.freeze({
  platform: typeof process === 'undefined' ? 'unknown' : process.platform,
  appVersion: getAppVersion(),
  local: localApi,
  notifications: notificationApi,
  updater: updaterApi,
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
