import type { BackupFingerprint, BackupRecordCounts } from './sqlite';

/**
 * Shared cloud-backup types for the main process, the preload bridge and the
 * renderer. The renderer never touches Node, `node:crypto`, the filesystem or
 * the Worker directly — it only sees these plain, structured values.
 */

export const BACKUP_IPC_CHANNELS = Object.freeze({
  getState: 'dks:backup:get-state',
  runNow: 'dks:backup:run-now',
  list: 'dks:backup:list',
  download: 'dks:backup:download',
  testDrill: 'dks:backup:test-drill',
  setupKey: 'dks:backup:setup-key',
  healthCheck: 'dks:backup:health-check',
  /**
   * Not in the original channel list, and required: the Supabase JWT lives in
   * the renderer's session storage, so main cannot authorise a Worker call
   * without it. Same trust model as `dks:local:set-session-clearance` —
   * convenience for the honest renderer only. The Worker verifies the signed
   * JWT and looks the role up itself, so a hostile renderer gains nothing.
   */
  setSession: 'dks:backup:set-session',
} as const);

export type BackupIpcChannel = (typeof BACKUP_IPC_CHANNELS)[keyof typeof BACKUP_IPC_CHANNELS];

export type BackupTrigger = 'launch' | 'quit' | 'hourly' | 'manual';

/**
 *  verified     uploaded and the stored checksum matched
 *  pending      encrypted locally, waiting for a confirmed upload
 *  failed       attempted and did not complete
 *  no_changes   checked; the fingerprint had not moved, nothing uploaded
 *  incomplete   skipped on purpose (pending local changes), retried later
 */
export type BackupOutcome = 'verified' | 'pending' | 'failed' | 'no_changes' | 'incomplete';

export interface BackupEvent {
  id: string;
  at: string;
  trigger: BackupTrigger;
  outcome: BackupOutcome;
  /** Short, safe, technical text. Never customer data. */
  detail: string | null;
  sizeBytes: number | null;
  recordCount: number | null;
  /** Server object key when an upload was confirmed. */
  objectKey: string | null;
  /** Public key identifier (SHA-256 prefix) of the key used, if known. */
  keyId: string | null;
}

export interface BackupState {
  /** Admin on/off toggle. */
  enabled: boolean;
  /** True once the key wizard has completed on this PC. */
  keyConfigured: boolean;
  /** Whether a recovery-key verification hash is stored. */
  recoveryKeyStored: boolean;
  workerUrl: string | null;
  connection: 'not_configured' | 'signed_out' | 'offline' | 'ok' | 'error' | 'unknown';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** Asia/Muscat calendar date (YYYY-MM-DD) of the last confirmed upload. */
  lastSuccessDate: string | null;
  lastFingerprint: string | null;
  lastSizeBytes: number | null;
  lastRecordCount: number | null;
  /** Encrypted files waiting for a confirmed upload. */
  pendingUploads: number;
  nextCheckAt: string | null;
  lastOutcome: BackupOutcome | null;
  lastError: string | null;
  /** Retention window advertised in the UI. */
  retentionDays: number;
  running: boolean;
  /**
   * Public identifier of the key on this PC (first 12 bytes of SHA-256(key),
   * hex), or null when no key is set up. Shown so an administrator can match a
   * backup to the recovery key that opens it. It is a hash prefix, not a key.
   */
  keyId: string | null;
  /**
   * What every backup from this build covers. Always 'local-cache' in PR1: the
   * local SQLite cache, not an authoritative Supabase read.
   */
  source: 'local-cache';
}

export interface BackupHistoryEntry {
  /** Asia/Muscat calendar date, YYYY-MM-DD. */
  day: string;
  sizeBytes: number | null;
  outcome: BackupOutcome;
  objectKey: string | null;
  createdAt: string | null;
  recordCount: number | null;
  /** Which key opens this backup; null when the object predates key ids. */
  keyId: string | null;
  /** What the snapshot covers. Always 'local-cache' in PR1. */
  source: string | null;
}

export interface BackupListQuery {
  year: number;
  month: number;
  cursor?: string | null;
}

export interface BackupListResult {
  year: number;
  month: number;
  entries: BackupHistoryEntry[];
  nextCursor: string | null;
}

export interface BackupRunResult {
  outcome: BackupOutcome;
  detail: string | null;
  sizeBytes: number | null;
  recordCount: number | null;
  objectKey: string | null;
  fingerprint: string | null;
}

export interface BackupKeySetupResult {
  ok: boolean;
  /** Present ONLY on the generate step, and only in this single response. */
  recoveryKey?: string;
  /** Public key identifier after a successful generate/confirm/import. */
  keyId?: string;
  message: string;
}

export interface BackupDrillResult {
  ok: boolean;
  stage: 'download' | 'decrypt' | 'checksum' | 'integrity' | 'cleanup';
  sizeBytes: number | null;
  integrityCheck: string | null;
  message: string;
}

export interface BackupHealthResult {
  ok: boolean;
  reachable: boolean;
  r2Bound: boolean;
  detail: string | null;
}

/**
 * What the renderer pushes so the main process can authorise a Worker call.
 * The Worker URL is admin configuration persisted by the main process, not
 * something the session carries, so it is optional here.
 */
export interface BackupSessionCredential {
  role: 'admin' | 'office';
  accessToken: string;
  workerUrl?: string;
}

export interface BackupSnapshotMeta {
  fingerprint: string;
  fingerprintParts: BackupFingerprint;
  recordCounts: BackupRecordCounts;
  createdAt: string;
}

export type { BackupFingerprint, BackupRecordCounts };
