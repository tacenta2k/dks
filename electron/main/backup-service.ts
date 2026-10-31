import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import log from 'electron-log';

import {
  BACKUP_SOURCE,
  BackupCryptoError,
  decryptBackup,
  encryptBackup,
  formatRecoveryKey,
  generateBackupKey,
  isKeyId,
  keyIdFromKey,
  keyIdFromStoredHash,
  keyVerificationHash,
  matchesStoredKey,
  parseRecoveryKey,
  tryLoadSafeStorage,
  unwrapStoredKey,
  wrapKeyForStorage,
  type BackupMetadata,
  type SafeStorageLike,
} from './backup-crypto';
import { createSnapshot, fingerprintDigest, safeUnlink } from './backup-snapshot';
import {
  BackupApiClient,
  BackupApiError,
  credentialFrom,
  normalizeWorkerUrl,
  safeRemove,
} from './backup-client';
import {
  BackupSingleFlight,
  hasUnpushedLocalChanges,
  HOURLY_CHECK_INTERVAL_MS,
  muscatDateFor,
  nextCheckAt,
  OUTBOX_DRAIN_POLL_MS,
  OUTBOX_DRAIN_TIMEOUT_MS,
  QUIT_BACKUP_BUDGET_MS,
  shouldRunTrigger,
  waitForOutboxDrain,
  type BackupTriggerState,
} from './backup-scheduler';
import type {
  BackupDrillResult,
  BackupEvent,
  BackupHealthResult,
  BackupHistoryEntry,
  BackupKeySetupResult,
  BackupListQuery,
  BackupListResult,
  BackupOutcome,
  BackupRunResult,
  BackupSessionCredential,
  BackupState,
  BackupTrigger,
} from './backup-types';
import { muscatDateOf, type SqliteStore } from './sqlite';

/**
 * Cloud backup orchestration (PR1: snapshot, encrypt, upload, list, download,
 * test-restore drill). No delete and no restore — those are PR2/PR3.
 *
 * Everything runs in the main process. The renderer only sends structured
 * requests and receives plain values.
 */

/**
 * What a confirmed upload really is. Never described as a complete Supabase
 * backup: it is a snapshot of this PC's local cache.
 */
const VERIFIED_DETAIL = 'Uploaded and verified (local cache snapshot)';

const STATE_KEY = 'dks.backup.state';
const KEY_HASH_META_KEY = 'dks.backup.keyHash';
const EVENTS_KEY = 'dks.backup.events';
const MAX_EVENTS = 200;

export interface BackupServiceOptions {
  store: Pick<
    SqliteStore,
    | 'computeBackupFingerprint'
    | 'createSnapshotCopy'
    | 'getMigrationVersion'
    | 'getBackupMeta'
    | 'setBackupMeta'
    | 'listOutbox'
  >;
  /** `app.getPath('userData')` — %APPDATA%\DKS on Windows. */
  userDataPath: string;
  appVersion: string;
  safeStorage?: SafeStorageLike | null;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Fire the launch check (T1) automatically when a session first arrives.
   * Production leaves this at its default; tests turn it off so they control
   * when a run starts.
   */
  autoLaunchCheck?: boolean;
  /** Test hook: bypass safeStorage with a fixed key. Never set in production. */
  keyOverrideForTests?: Buffer;
  logger?: Pick<typeof log, 'info' | 'warn' | 'error'>;
}

interface PersistedState {
  enabled: boolean;
  workerUrl: string | null;
  keyConfigured: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastSuccessDate: string | null;
  lastCheckedDate: string | null;
  lastFingerprint: string | null;
  lastSizeBytes: number | null;
  lastRecordCount: number | null;
  lastOutcome: BackupOutcome | null;
  lastError: string | null;
  lastHealthOkAt: string | null;
  nextCheckAt: string | null;
}

const DEFAULT_STATE: PersistedState = {
  /**
   * Off until an administrator turns it on in Settings. Nothing leaves this PC
   * because DKS was installed: uploading a cache is a decision, not a default.
   */
  enabled: false,
  workerUrl: null,
  keyConfigured: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastSuccessDate: null,
  lastCheckedDate: null,
  lastFingerprint: null,
  lastSizeBytes: null,
  lastRecordCount: null,
  lastOutcome: null,
  lastError: null,
  lastHealthOkAt: null,
  nextCheckAt: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPersisted(raw: string | null): PersistedState {
  if (!raw) return { ...DEFAULT_STATE };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { ...DEFAULT_STATE };
    return {
      enabled: parsed.enabled === undefined ? DEFAULT_STATE.enabled : parsed.enabled === true,
      workerUrl: typeof parsed.workerUrl === 'string' ? parsed.workerUrl : null,
      keyConfigured: parsed.keyConfigured === true,
      lastAttemptAt: typeof parsed.lastAttemptAt === 'string' ? parsed.lastAttemptAt : null,
      lastSuccessAt: typeof parsed.lastSuccessAt === 'string' ? parsed.lastSuccessAt : null,
      lastSuccessDate: typeof parsed.lastSuccessDate === 'string' ? parsed.lastSuccessDate : null,
      lastCheckedDate: typeof parsed.lastCheckedDate === 'string' ? parsed.lastCheckedDate : null,
      lastFingerprint: typeof parsed.lastFingerprint === 'string' ? parsed.lastFingerprint : null,
      lastSizeBytes: typeof parsed.lastSizeBytes === 'number' ? parsed.lastSizeBytes : null,
      lastRecordCount: typeof parsed.lastRecordCount === 'number' ? parsed.lastRecordCount : null,
      lastOutcome: typeof parsed.lastOutcome === 'string' ? parsed.lastOutcome as BackupOutcome : null,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      lastHealthOkAt: typeof parsed.lastHealthOkAt === 'string' ? parsed.lastHealthOkAt : null,
      nextCheckAt: typeof parsed.nextCheckAt === 'string' ? parsed.nextCheckAt : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export class BackupService {
  private readonly store: BackupServiceOptions['store'];
  private readonly userDataPath: string;
  private readonly appVersion: string;
  private readonly safeStorage: SafeStorageLike | null;
  private readonly now: () => Date;
  private readonly fetchImpl?: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: NonNullable<BackupServiceOptions['logger']>;
  private readonly keyOverrideForTests?: Buffer;
  private readonly flight = new BackupSingleFlight();
  private credential: BackupSessionCredential | null = null;
  private hourlyTimer: ReturnType<typeof setInterval> | undefined;
  private lastHealthOk = false;
  private launchCheckDone = false;
  private autoLaunchCheck = true;

  public constructor(options: BackupServiceOptions) {
    this.store = options.store;
    this.userDataPath = options.userDataPath;
    this.appVersion = options.appVersion;
    this.safeStorage = options.safeStorage === undefined ? tryLoadSafeStorage() : options.safeStorage;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl;
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger ?? log;
    this.keyOverrideForTests = options.keyOverrideForTests;
    this.autoLaunchCheck = options.autoLaunchCheck !== false;
  }

  // --------------------------------------------------------------------- paths

  private get backupsRoot(): string {
    return path.join(this.userDataPath, 'backups');
  }

  private get pendingDir(): string {
    return path.join(this.backupsRoot, 'pending');
  }

  private get tmpDir(): string {
    return path.join(this.backupsRoot, 'tmp');
  }

  private get keyPath(): string {
    return path.join(this.userDataPath, 'backup-key.bin');
  }

  // -------------------------------------------------------------------- state

  private readState(): PersistedState {
    try {
      return readPersisted(this.store.getBackupMeta(STATE_KEY));
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private writeState(state: PersistedState): void {
    try {
      this.store.setBackupMeta(STATE_KEY, JSON.stringify(state));
    } catch (error) {
      this.logger.warn('[dks-backup] could not persist backup state', error);
    }
  }

  private patchState(patch: Partial<PersistedState>): PersistedState {
    const next = { ...this.readState(), ...patch };
    this.writeState(next);
    return next;
  }

  public isEnabled(): boolean {
    return this.readState().enabled;
  }

  public setEnabled(enabled: boolean): BackupState {
    this.patchState({ enabled });
    return this.getState();
  }

  public setWorkerUrl(workerUrl: string): BackupState {
    // Validated here so only an https Worker URL is ever persisted.
    const normalized = normalizeWorkerUrl(workerUrl);
    this.patchState({ workerUrl: normalized });
    return this.getState();
  }

  public getState(): BackupState {
    const state = this.readState();
    const pending = this.listPendingFiles();
    const connection: BackupState['connection'] = !state.workerUrl
      ? 'not_configured'
      : !this.credential
        ? 'signed_out'
        : state.lastHealthOkAt !== null || this.lastHealthOk
          ? 'ok'
          : state.lastAttemptAt === null
            ? 'unknown'
            : 'error';
    return {
      enabled: state.enabled,
      keyConfigured: state.keyConfigured || fs.existsSync(this.keyPath) || this.keyOverrideForTests !== undefined,
      recoveryKeyStored: this.recoveryHashStored(),
      workerUrl: state.workerUrl,
      connection,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastSuccessDate: state.lastSuccessDate,
      lastFingerprint: state.lastFingerprint,
      lastSizeBytes: state.lastSizeBytes,
      lastRecordCount: state.lastRecordCount,
      pendingUploads: pending.length,
      nextCheckAt: state.nextCheckAt,
      lastOutcome: state.lastOutcome,
      lastError: state.lastError,
      retentionDays: 90,
      running: this.flight.running,
      keyId: this.currentKeyId(),
      source: BACKUP_SOURCE,
    };
  }

  // --------------------------------------------------------------------- keys

  private recoveryHashStored(): boolean {
    try {
      const hash = this.store.getBackupMeta(KEY_HASH_META_KEY);
      return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
    } catch {
      return false;
    }
  }

  /**
   * Key wizard step 1: generate a fresh 256-bit key, wrap it with the OS key
   * store and return the recovery key ONCE. The plaintext key is never written
   * to disk and never leaves this response.
   */
  public setupKeyGenerate(): BackupKeySetupResult {
    try {
      const key = generateBackupKey();
      const wrapped = wrapKeyForStorage(key, this.safeStorage);
      fs.mkdirSync(this.userDataPath, { recursive: true });
      fs.writeFileSync(this.keyPath, wrapped, { mode: 0o600 });
      this.store.setBackupMeta(KEY_HASH_META_KEY, keyVerificationHash(key));
      this.patchState({ keyConfigured: true });
      this.logger.info('[dks-backup] backup key created and protected by the OS key store');
      return {
        ok: true,
        recoveryKey: formatRecoveryKey(key),
        keyId: keyIdFromKey(key),
        message: 'Copy this recovery key now. DKS shows it only once.',
      };
    } catch (error) {
      const message = error instanceof BackupCryptoError
        ? error.message
        : 'DKS could not create the backup key on this PC';
      return { ok: false, message };
    }
  }

  /**
   * Key wizard step 2: prove the typed recovery key matches the stored hash.
   * Fails setup if it does not — a key nobody can reproduce is worse than none.
   */
  public setupKeyConfirm(recoveryKey: string): BackupKeySetupResult {
    try {
      const candidate = parseRecoveryKey(recoveryKey);
      const stored = this.store.getBackupMeta(KEY_HASH_META_KEY);
      if (!stored) {
        return { ok: false, message: 'No backup key has been created yet' };
      }
      if (!matchesStoredKey(candidate, stored)) {
        return { ok: false, message: 'That recovery key does not match the key DKS created' };
      }
      // Confirm the wrapped key is actually readable on this PC.
      void this.readLocalKey();
      return {
        ok: true,
        keyId: keyIdFromKey(candidate),
        message: 'Recovery key confirmed. Cloud backup is ready.',
      };
    } catch (error) {
      const message = error instanceof BackupCryptoError
        ? error.message
        : 'That recovery key could not be checked';
      return { ok: false, message };
    }
  }

  /**
   * Import a recovery key on a PC that does not have it — the replacement-PC
   * path. Without this, a backup made on the old machine could never be opened
   * again on a new one.
   *
   * Steps, all local and none of them plaintext-persisting:
   *   1. base64 → exactly 32 bytes (anything else is refused);
   *   2. derive the public key id and, when the caller names one (e.g. the id
   *      stored on a backup they want to open), require an exact match;
   *   3. if this PC already has a key recorded, require the imported key to
   *      match it, so a typo cannot silently replace a working key;
   *   4. wrap with `safeStorage` and write mode 0600. If the OS key store is
   *      unavailable this fails closed — there is no plaintext fallback;
   *   5. record SHA-256(key) so the wizard can verify a future paste-back.
   *
   * Note: importing a key does NOT authorize anything in the cloud and does not
   * restore data. It only makes decryption possible on this PC.
   */
  public setupKeyImport(recoveryKey: string, expectedKeyId?: string | null): BackupKeySetupResult {
    let key: Buffer;
    try {
      key = parseRecoveryKey(recoveryKey);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof BackupCryptoError
          ? error.message
          : 'That recovery key could not be read',
      };
    }

    const keyId = keyIdFromKey(key);
    if (expectedKeyId !== undefined && expectedKeyId !== null && expectedKeyId !== '') {
      const wanted = String(expectedKeyId).trim().toLowerCase();
      if (!isKeyId(wanted)) {
        return { ok: false, message: 'That is not a valid key identifier' };
      }
      if (wanted !== keyId) {
        return {
          ok: false,
          message: `That recovery key does not match backup key ${wanted}. This key is ${keyId}.`,
        };
      }
    }

    const existing = this.recoveryHashStored()
      ? keyIdFromStoredHash(this.store.getBackupMeta(KEY_HASH_META_KEY))
      : null;
    if (existing && existing !== keyId) {
      return {
        ok: false,
        message: `This PC already holds a different backup key (${existing}). Importing would change which key future backups use.`,
      };
    }

    try {
      const wrapped = wrapKeyForStorage(key, this.safeStorage);
      fs.mkdirSync(this.userDataPath, { recursive: true });
      fs.writeFileSync(this.keyPath, wrapped, { mode: 0o600 });
      this.store.setBackupMeta(KEY_HASH_META_KEY, keyVerificationHash(key));
      this.patchState({ keyConfigured: true });
      this.logger.info(`[dks-backup] recovery key imported; key id ${keyId}`);
      return {
        ok: true,
        keyId,
        message: 'Recovery key imported. This PC can now open backups made with it.',
      };
    } catch (error) {
      const message = error instanceof BackupCryptoError
        ? error.message
        : 'DKS could not protect the imported key on this PC';
      this.logger.warn('[dks-backup] recovery key import failed');
      return { ok: false, message };
    }
  }

  private readLocalKey(): Buffer {
    if (this.keyOverrideForTests) {
      return this.keyOverrideForTests;
    }
    if (!fs.existsSync(this.keyPath)) {
      throw new BackupCryptoError('KEY_UNAVAILABLE', 'No backup key exists on this PC yet');
    }
    return unwrapStoredKey(fs.readFileSync(this.keyPath), this.safeStorage);
  }

  // ----------------------------------------------------------------- session

  /** Renderer pushes the current Supabase session; held in memory only. */
  public setSession(input: unknown): boolean {
    if (input === null || input === undefined) {
      this.credential = null;
      this.lastHealthOk = false;
      return true;
    }
    const credential = credentialFrom(input);
    if (!credential) {
      return false;
    }
    try {
      // A worker URL pushed with the session is admin configuration: persist it
      // so the scheduler and the Settings card read the same value.
      if (credential.workerUrl) {
        this.patchState({ workerUrl: normalizeWorkerUrl(credential.workerUrl) });
      }
      this.credential = { role: credential.role, accessToken: credential.accessToken };
    } catch {
      this.credential = null;
      return false;
    }

    // T1: the launch check needs a signed-in session, which only exists once
    // the renderer has restored one. Run it once per process, here, so the
    // backup never has to guess when the JWT became available.
    if (this.autoLaunchCheck && !this.launchCheckDone && this.readState().enabled) {
      this.launchCheckDone = true;
      void this.runNow('launch').catch((error) => {
        this.logger.warn('[dks-backup] launch check failed', error);
      });
    }
    return true;
  }

  private client(): BackupApiClient {
    const workerUrl = this.readState().workerUrl ?? this.credential?.workerUrl;
    if (!workerUrl) {
      throw new BackupApiError('NOT_CONFIGURED', 'Add the backup service address in Settings');
    }
    if (!this.credential) {
      throw new BackupApiError('UNAUTHORIZED', 'Sign in to DKS before using cloud backup');
    }
    return new BackupApiClient({
      workerUrl,
      accessToken: this.credential.accessToken,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      appVersion: this.appVersion,
    });
  }

  // -------------------------------------------------------------- pending dir

  private listPendingFiles(): string[] {
    try {
      if (!fs.existsSync(this.pendingDir)) return [];
      return fs.readdirSync(this.pendingDir)
        .filter((name) => name.endsWith('.sqlite.enc'))
        .sort()
        .map((name) => path.join(this.pendingDir, name));
    } catch {
      return [];
    }
  }

  private pendingMetaPath(payloadPath: string): string {
    return `${payloadPath}.meta.json`;
  }

  private readPendingMeta(payloadPath: string): BackupMetadata | null {
    try {
      const raw = fs.readFileSync(this.pendingMetaPath(payloadPath), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? parsed as unknown as BackupMetadata : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------- events

  public listEvents(): BackupEvent[] {
    try {
      const raw = this.store.getBackupMeta(EVENTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isRecord) as unknown as BackupEvent[] : [];
    } catch {
      return [];
    }
  }

  /**
   * Public identifier of the key on this PC — the first 12 bytes of the stored
   * SHA-256(key) hash. It is a one-way prefix, safe to display and to store in
   * R2 metadata; it is never the key itself.
   */
  private currentKeyId(): string | null {
    if (this.keyOverrideForTests) {
      return keyIdFromKey(this.keyOverrideForTests);
    }
    try {
      return keyIdFromStoredHash(this.store.getBackupMeta(KEY_HASH_META_KEY));
    } catch {
      return null;
    }
  }

  private recordEvent(event: Omit<BackupEvent, 'id' | 'keyId'> & { keyId?: string | null }): void {
    const record: BackupEvent = {
      ...event,
      keyId: event.keyId === undefined ? this.currentKeyId() : event.keyId,
      id: randomBytes(6).toString('hex'),
    };
    const events = [record, ...this.listEvents()].slice(0, MAX_EVENTS);
    try {
      this.store.setBackupMeta(EVENTS_KEY, JSON.stringify(events));
    } catch (error) {
      this.logger.warn('[dks-backup] could not persist backup history', error);
    }
  }

  // ------------------------------------------------------------------ outbox

  private outboxCounts(): { pending: number; processing: number; failed: number } {
    const count = (status: string): number => {
      try {
        return this.store.listOutbox(status).length;
      } catch {
        return 0;
      }
    };
    return { pending: count('pending'), processing: count('processing'), failed: count('failed') };
  }

  // ------------------------------------------------------------------- run

  public async runNow(trigger: BackupTrigger = 'manual'): Promise<BackupRunResult> {
    const attempt = await this.flight.run(() => this.runInternal(trigger));
    if (attempt.result) {
      return attempt.result as BackupRunResult;
    }
    // Only reachable if a run resolved to nothing, which runInternal never does.
    return {
      outcome: 'no_changes',
      detail: 'A backup is already running',
      sizeBytes: null,
      recordCount: null,
      objectKey: null,
      fingerprint: null,
    };
  }

  private async runInternal(trigger: BackupTrigger): Promise<BackupRunResult> {
    const startedAt = this.now();
    const state = this.readState();

    let fingerprint: string;
    try {
      fingerprint = fingerprintDigest(this.store.computeBackupFingerprint());
    } catch (error) {
      const detail = 'The local database could not be read';
      this.patchState({ lastAttemptAt: startedAt.toISOString(), lastOutcome: 'failed', lastError: detail });
      this.recordEvent({
        at: startedAt.toISOString(), trigger, outcome: 'failed', detail,
        sizeBytes: null, recordCount: null, objectKey: null,
      });
      return { outcome: 'failed', detail, sizeBytes: null, recordCount: null, objectKey: null, fingerprint: null };
    }

    const decision = shouldRunTrigger(trigger, this.triggerState(state), { now: this.now, fingerprint });
    this.patchState({ lastAttemptAt: startedAt.toISOString(), nextCheckAt: nextCheckAt(this.now()) });

    if (!decision.run) {
      if (decision.reason === 'already_checked_today') {
        this.recordEvent({
          at: startedAt.toISOString(), trigger, outcome: 'no_changes', detail: decision.detail,
          sizeBytes: null, recordCount: null, objectKey: null,
        });
        this.patchState({
          lastCheckedDate: muscatDateFor(this.now()),
          lastOutcome: 'no_changes',
          lastError: null,
        });
        return { outcome: 'no_changes', detail: decision.detail, sizeBytes: null, recordCount: null, objectKey: null, fingerprint };
      }
      return { outcome: 'no_changes', detail: decision.detail, sizeBytes: null, recordCount: null, objectKey: null, fingerprint };
    }

    // 1. Give the renderer's sync engine a bounded window to push local edits.
    const drained = await waitForOutboxDrain(() => this.outboxCounts(), {
      now: () => this.now().getTime(),
      timeoutMs: OUTBOX_DRAIN_TIMEOUT_MS,
      pollMs: OUTBOX_DRAIN_POLL_MS,
      sleep: this.sleep,
    });
    if (hasUnpushedLocalChanges(drained)) {
      const detail = 'snapshot incomplete: pending local changes';
      this.patchState({
        lastOutcome: 'incomplete',
        lastError: detail,
        nextCheckAt: nextCheckAt(this.now(), 5 * 60 * 1000),
      });
      this.recordEvent({
        at: startedAt.toISOString(), trigger, outcome: 'incomplete', detail,
        sizeBytes: null, recordCount: null, objectKey: null,
      });
      this.logger.warn(`[dks-backup] ${detail} (pending=${String(drained.pending)} processing=${String(drained.processing)} failed=${String(drained.failed)})`);
      return { outcome: 'incomplete', detail, sizeBytes: null, recordCount: null, objectKey: null, fingerprint };
    }

    // 2. Snapshot, encrypt and queue — before any network call, so an offline
    //    PC still ends this run holding an encrypted, verified snapshot.
    //
    //    A snapshot is taken only when nothing is already queued. Stacking a
    //    second unconfirmed envelope on top of the first would grow the queue
    //    forever on a PC that stays offline, and oldest-first upload order
    //    would then keep publishing stale copies while the newest one sat
    //    unverified. Finishing the queued work comes first; the next trigger
    //    picks up anything that changed since.
    const alreadyQueued = this.listPendingFiles();
    let sizeBytes: number | null = null;
    let recordCount: number | null = null;
    if (alreadyQueued.length === 0) {
      try {
        const snapshot = await createSnapshot({ store: this.store, destinationDir: this.tmpDir, now: this.now });
        try {
          const plaintext = fs.readFileSync(snapshot.filePath);
          const key = this.readLocalKey();
          const meta: BackupMetadata = {
            plaintextSha256: '',
            fingerprint: snapshot.fingerprint,
            appVersion: this.appVersion,
            schemaVersion: this.safeSchemaVersion(),
            recordCounts: snapshot.recordCounts as unknown as Record<string, number>,
            createdAt: snapshot.createdAt,
            // Which key opens this file, and what the file actually covers.
            // PR1 snapshots are always the local cache — never claim more.
            keyId: this.currentKeyId() ?? '',
            source: BACKUP_SOURCE,
          };
          const encrypted = encryptBackup(plaintext, key, meta);
          sizeBytes = encrypted.payload.byteLength;
          recordCount = snapshot.recordCounts.entries;
          this.writePending(encrypted.payload, encrypted.metadata, startedAt);
        } finally {
          safeUnlink(snapshot.filePath);
        }
      } catch (error) {
        const detail = describeFailure(error, 'The backup could not be created on this PC');
        this.patchState({ lastOutcome: 'failed', lastError: detail });
        this.recordEvent({
          at: startedAt.toISOString(), trigger, outcome: 'failed', detail,
          sizeBytes: null, recordCount: null, objectKey: null,
        });
        return { outcome: 'failed', detail, sizeBytes: null, recordCount: null, objectKey: null, fingerprint: null };
      }
    } else {
      const newestQueued = alreadyQueued[alreadyQueued.length - 1];
      const queuedMeta = this.readPendingMeta(newestQueued);
      sizeBytes = this.safeSizeOf(newestQueued);
      recordCount = typeof queuedMeta?.recordCounts?.entries === 'number' ? queuedMeta.recordCounts.entries : null;
      this.logger.info(
        `[dks-backup] ${String(alreadyQueued.length)} queued backup(s) waiting — uploading those before taking a new snapshot`,
      );
    }

    // 3. Flush the pending queue oldest-first. Only a confirmed upload (server
    //    checksum re-read) removes a file and moves lastSuccess* forward.
    const upload = await this.flushPendingQueue();
    if (upload.ok) {
      const confirmedDate = muscatDateFor(this.now());
      // Record the fingerprint of the snapshot that was CONFIRMED, not the
      // fingerprint of the database right now. When an older snapshot was
      // queued, those two differ, and claiming the current one would make the
      // next trigger believe newer data is already backed up and skip it —
      // leaving "last successful backup" pointing at stale content forever.
      // `null` when the queued envelope carried no fingerprint: unknown is
      // treated as "nothing confirmed", which fails toward backing up again.
      const confirmedFingerprint = upload.fingerprint ?? null;
      this.patchState({
        lastSuccessAt: this.now().toISOString(),
        lastSuccessDate: confirmedDate,
        lastCheckedDate: confirmedDate,
        lastFingerprint: confirmedFingerprint,
        lastSizeBytes: upload.sizeBytes,
        lastRecordCount: upload.recordCount,
        lastOutcome: 'verified',
        lastError: null,
      });
      this.recordEvent({
        at: startedAt.toISOString(), trigger, outcome: 'verified', detail: VERIFIED_DETAIL,
        sizeBytes: upload.sizeBytes, recordCount: upload.recordCount, objectKey: upload.objectKey,
      });
      return {
        outcome: 'verified', detail: VERIFIED_DETAIL, sizeBytes: upload.sizeBytes,
        recordCount: upload.recordCount, objectKey: upload.objectKey, fingerprint: confirmedFingerprint,
      };
    }

    this.patchState({ lastOutcome: 'pending', lastError: upload.detail });
    this.recordEvent({
      at: startedAt.toISOString(), trigger, outcome: 'pending', detail: upload.detail,
      sizeBytes, recordCount, objectKey: null,
    });
    return {
      outcome: 'pending', detail: upload.detail, sizeBytes, recordCount, objectKey: null, fingerprint,
    };
  }

  private safeSchemaVersion(): number {
    try {
      return this.store.getMigrationVersion();
    } catch {
      return 0;
    }
  }

  private triggerState(state: PersistedState): BackupTriggerState {
    return {
      enabled: state.enabled,
      keyConfigured: state.keyConfigured || fs.existsSync(this.keyPath) || this.keyOverrideForTests !== undefined,
      // Both a signed-in session and a configured service address are needed
      // to upload at all, so neither alone may produce snapshots that could
      // only pile up in the pending folder.
      workerConfigured: Boolean(this.credential) && Boolean(state.workerUrl || this.credential?.workerUrl),
      lastCheckedDate: state.lastCheckedDate,
      lastSuccessDate: state.lastSuccessDate,
      lastFingerprint: state.lastFingerprint,
      lastAttemptAt: state.lastAttemptAt,
    };
  }

  private safeSizeOf(filePath: string): number | null {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return null;
    }
  }

  private writePending(payload: Buffer, metadata: BackupMetadata, at: Date): string {
    fs.mkdirSync(this.pendingDir, { recursive: true });
    const name = `${at.toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.sqlite.enc`;
    const filePath = path.join(this.pendingDir, name);
    fs.writeFileSync(filePath, payload, { mode: 0o600 });
    fs.writeFileSync(this.pendingMetaPath(filePath), JSON.stringify(metadata), { mode: 0o600 });
    return filePath;
  }

  /**
   * Upload every queued envelope, oldest first.
   *
   * A file is deleted ONLY after the server has re-read the stored object and
   * returned a SHA-256 that matches the one DKS computed locally. Anything
   * else — offline, 401, checksum mismatch — leaves the file queued, so pending
   * offline work is never lost silently and the newest verified snapshot is
   * never replaced by an unconfirmed one.
   */
  public async flushPendingQueue(): Promise<{
    ok: boolean;
    detail: string;
    sizeBytes: number | null;
    recordCount: number | null;
    objectKey: string | null;
    /**
     * Fingerprint of the snapshot that was actually uploaded — which is NOT
     * necessarily the current database state when an older snapshot was
     * queued. Optional so the failure paths can omit it.
     */
    fingerprint?: string | null;
  }> {
    const queued = this.listPendingFiles();
    if (queued.length === 0) {
      return { ok: false, detail: 'Nothing queued to upload', sizeBytes: null, recordCount: null, objectKey: null };
    }

    let api: BackupApiClient;
    try {
      api = this.client();
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof BackupApiError ? error.message : 'The backup service is not configured',
        sizeBytes: null, recordCount: null, objectKey: null,
      };
    }

    for (const filePath of queued) {
      const metadata = this.readPendingMeta(filePath);
      if (!metadata) {
        // An envelope with no metadata can never be verified; keep it and say so.
        return {
          ok: false,
          detail: 'A queued backup is missing its metadata and was kept for review',
          sizeBytes: null, recordCount: null, objectKey: null,
        };
      }
      try {
        const payload = fs.readFileSync(filePath);
        const uploaded = await api.upload(payload, metadata);
        const confirmed = await api.verifyStored(uploaded.key, uploaded.ciphertextSha256);
        if (!confirmed.ok) {
          return {
            ok: false,
            detail: 'The uploaded backup did not match its checksum, so it was kept queued',
            sizeBytes: payload.byteLength, recordCount: null, objectKey: uploaded.key,
          };
        }
        safeRemove(filePath);
        safeRemove(this.pendingMetaPath(filePath));
        this.lastHealthOk = true;
        this.patchState({ lastHealthOkAt: this.now().toISOString() });
        return {
          ok: true,
          detail: 'Uploaded and verified',
          sizeBytes: uploaded.size,
          recordCount: typeof metadata.recordCounts?.entries === 'number' ? metadata.recordCounts.entries : null,
          objectKey: uploaded.key,
          fingerprint: typeof metadata.fingerprint === 'string' && metadata.fingerprint.length > 0
            ? metadata.fingerprint
            : null,
        };
      } catch (error) {
        const detail = describeFailure(error, 'The backup could not be uploaded');
        this.lastHealthOk = false;
        return { ok: false, detail, sizeBytes: null, recordCount: null, objectKey: null };
      }
    }

    return { ok: false, detail: 'Nothing queued to upload', sizeBytes: null, recordCount: null, objectKey: null };
  }

  /**
   * Before-quit attempt. Bounded: if the work cannot finish inside the budget
   * the encrypted file stays queued for the next launch and the app quits.
   */
  public async runBeforeQuit(budgetMs: number = QUIT_BACKUP_BUDGET_MS): Promise<BackupRunResult> {
    const timedOut = Symbol('quit-timeout');
    const result = await Promise.race([
      this.runNow('quit'),
      new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), budgetMs)),
    ]);
    if (result === timedOut) {
      return {
        outcome: 'pending',
        detail: 'Backed up locally; the upload will finish at the next launch',
        sizeBytes: null, recordCount: null, objectKey: null, fingerprint: null,
      };
    }
    return result;
  }

  // ------------------------------------------------------------------ health

  public async healthCheck(): Promise<BackupHealthResult> {
    try {
      const api = this.client();
      const result = await api.healthCheck();
      this.lastHealthOk = result.ok;
      this.patchState({ lastHealthOkAt: result.ok ? this.now().toISOString() : null });
      return result;
    } catch (error) {
      this.lastHealthOk = false;
      return {
        ok: false,
        reachable: false,
        r2Bound: false,
        detail: error instanceof BackupApiError ? error.message : 'The backup service is unreachable',
      };
    }
  }

  // ------------------------------------------------------------------- list

  public async list(query: BackupListQuery): Promise<BackupListResult> {
    const api = this.client();
    const result = await api.list(query);
    const events = this.listEvents();
    // Merge local outcomes (pending / failed / no changes / incomplete) with the
    // server's verified objects so one day shows one truthful status.
    const byDay = new Map<string, BackupHistoryEntry>();
    for (const event of events) {
      const day = muscatDateOf(event.at);
      const existing = byDay.get(day);
      if (!existing || rankOutcome(event.outcome) > rankOutcome(existing.outcome)) {
        byDay.set(day, {
          day,
          sizeBytes: event.sizeBytes,
          outcome: event.outcome,
          objectKey: event.objectKey,
          createdAt: event.at,
          recordCount: event.recordCount,
          keyId: event.keyId ?? null,
          source: BACKUP_SOURCE,
        });
      }
    }
    for (const entry of result.entries) {
      if (!entry.day) continue;
      const existing = byDay.get(entry.day);
      if (!existing || entry.outcome === 'verified') {
        byDay.set(entry.day, { ...entry, outcome: 'verified' });
      }
    }
    return {
      ...result,
      entries: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)),
    };
  }

  // --------------------------------------------------------------- download

  /** Download one object to a temp path. Used by the drill; admin only via IPC. */
  public async download(objectKey: string, destinationDir?: string): Promise<{ filePath: string; sizeBytes: number; sha256: string }> {
    const api = this.client();
    const dir = destinationDir ?? this.tmpDir;
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `download-${randomBytes(4).toString('hex')}.sqlite.enc`);
    const result = await api.download(objectKey, filePath);
    return { filePath, sizeBytes: result.sizeBytes, sha256: result.sha256 };
  }

  // ------------------------------------------------------------------- drill

  /**
   * Test-restore drill: download the latest backup, decrypt it, verify the GCM
   * tag, the plaintext checksum and `PRAGMA integrity_check`, then delete every
   * temp file. It never opens, writes or replaces the live database.
   */
  public async testDrill(recoveryKey?: string): Promise<BackupDrillResult> {
    let filePath: string | null = null;
    try {
      const api = this.client();
      const objectKey = await api.latestObjectKey(this.now);
      if (!objectKey) {
        return { ok: false, stage: 'download', sizeBytes: null, integrityCheck: null, message: 'No verified backup has been uploaded yet' };
      }
      const downloaded = await this.download(objectKey);
      filePath = downloaded.filePath;

      let key: Buffer;
      try {
        key = recoveryKey && recoveryKey.trim() ? parseRecoveryKey(recoveryKey) : this.readLocalKey();
      } catch (error) {
        return {
          ok: false, stage: 'decrypt', sizeBytes: downloaded.sizeBytes, integrityCheck: null,
          message: error instanceof BackupCryptoError ? error.message : 'The backup key could not be read',
        };
      }

      const payload = fs.readFileSync(filePath);
      const result = await api.listMetadataFor(objectKey);
      const metadata = result.metadata;
      if (!metadata) {
        return { ok: false, stage: 'checksum', sizeBytes: downloaded.sizeBytes, integrityCheck: null, message: 'The backup has no stored metadata' };
      }

      // Byte-level check of what R2 actually sent back. The Worker streams
      // uploads straight to R2 and cannot hash a large body inside its memory
      // limit, so the stored ciphertext checksum is the one DKS declared at
      // upload time; hashing the downloaded bytes here and comparing is what
      // turns it into real evidence that storage did not alter the object.
      if (result.ciphertextSha256 && downloaded.sha256.toLowerCase() !== result.ciphertextSha256.toLowerCase()) {
        return {
          ok: false, stage: 'checksum', sizeBytes: downloaded.sizeBytes, integrityCheck: null,
          message: 'The downloaded backup did not match the checksum recorded at upload',
        };
      }

      // Name the key mismatch instead of a generic decryption failure: on a
      // replacement PC the usual cause is holding the wrong recovery key.
      const wantedKeyId = isKeyId(metadata.keyId) ? metadata.keyId : null;
      const usedKeyId = keyIdFromKey(key);
      if (wantedKeyId && usedKeyId && wantedKeyId !== usedKeyId) {
        return {
          ok: false, stage: 'decrypt', sizeBytes: downloaded.sizeBytes, integrityCheck: null,
          message: `This backup was encrypted with key ${wantedKeyId}; the key available here is ${usedKeyId}. Import the matching recovery key first.`,
        };
      }

      let plaintext: Buffer;
      try {
        plaintext = decryptBackup(payload, key, metadata).plaintext;
      } catch (error) {
        return {
          ok: false, stage: 'decrypt', sizeBytes: downloaded.sizeBytes, integrityCheck: null,
          message: error instanceof BackupCryptoError ? error.message : 'The backup could not be decrypted',
        };
      }

      const restored = path.join(path.dirname(filePath), `drill-${randomBytes(4).toString('hex')}.sqlite`);
      fs.writeFileSync(restored, plaintext, { mode: 0o600 });
      let integrityCheck = 'unknown';
      try {
        const database = new BetterSqlite3(restored, { readonly: true, fileMustExist: true });
        try {
          const rows = database.pragma('integrity_check') as Array<{ integrity_check?: unknown }>;
          integrityCheck = rows.map((row) => String(row.integrity_check ?? '')).join('; ').trim() || 'unknown';
        } finally {
          database.close();
        }
      } catch {
        integrityCheck = 'unreadable';
      } finally {
        safeUnlink(restored);
      }

      if (integrityCheck !== 'ok') {
        return {
          ok: false, stage: 'integrity', sizeBytes: downloaded.sizeBytes, integrityCheck,
          message: `The restored copy reported: ${integrityCheck}`,
        };
      }

      return {
        ok: true, stage: 'cleanup', sizeBytes: downloaded.sizeBytes, integrityCheck,
        message: 'The latest backup downloaded, decrypted and passed the integrity check',
      };
    } catch (error) {
      return {
        ok: false, stage: 'download', sizeBytes: null, integrityCheck: null,
        message: describeFailure(error, 'The drill could not reach the backup service'),
      };
    } finally {
      // The drill leaves nothing behind: both the encrypted download and the
      // decrypted copy are removed on every path, success or failure.
      if (filePath) safeRemove(filePath);
    }
  }

  // --------------------------------------------------------------- lifecycle

  /** T3: hourly check while the app is running. */
  public startHourlyTimer(intervalMs: number = HOURLY_CHECK_INTERVAL_MS): void {
    this.stopHourlyTimer();
    this.hourlyTimer = setInterval(() => {
      void this.runNow('hourly').catch((error) => {
        this.logger.warn('[dks-backup] hourly check failed', error);
      });
    }, intervalMs);
    if (typeof this.hourlyTimer.unref === 'function') {
      this.hourlyTimer.unref();
    }
  }

  public stopHourlyTimer(): void {
    if (this.hourlyTimer) {
      clearInterval(this.hourlyTimer);
      this.hourlyTimer = undefined;
    }
  }
}

/** Ordering used to pick the most informative status for one day. */
function rankOutcome(outcome: BackupOutcome): number {
  switch (outcome) {
    case 'verified': return 5;
    case 'pending': return 4;
    case 'incomplete': return 3;
    case 'failed': return 2;
    case 'no_changes': return 1;
    default: return 0;
  }
}

/**
 * Failure text for the admin UI. Technical and bounded; never echoes a request
 * body, a token or anything from the database.
 */
export function describeFailure(error: unknown, fallback: string): string {
  if (error instanceof BackupApiError) return error.message;
  if (error instanceof BackupCryptoError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 240);
  return fallback;
}

export function createBackupService(options: BackupServiceOptions): BackupService {
  return new BackupService(options);
}
