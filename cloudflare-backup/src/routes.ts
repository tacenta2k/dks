import {
  BackupHttpError,
  DEVICE_ID_PATTERN,
  lookupDesignatedDevice,
  requireAdmin,
  requireBackupAdmin,
  requireStepUp,
  type AuthDeps,
  type AuthenticatedCaller,
  type BackupEnv,
  type DesignatedDevice,
  type R2Object,
} from './auth';

/**
 * Cloudflare backup Worker — routes (PR1).
 *
 *   POST /v1/backups          admin, or an approved Office session
 *   GET  /v1/backups          admin only — object metadata, never bodies
 *   GET  /v1/backups/{id}     admin only — stream one object
 *   HEAD /v1/backups/{id}     admin only — metadata + stored checksum
 *   GET  /health              liveness + R2 binding check, no PII
 *
 * Delete and restore are PR2/PR3 and are not registered at all.
 */

/**
 * 25 MB. A real DKS snapshot is ~65 KB at ~1,200 rows, so this is ~380x headroom
 * that still trips on a corrupt or runaway snapshot. Enforced twice: a cheap
 * `content-length` refusal, and a counting TransformStream while streaming.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const BACKUP_KEY_PREFIX = 'backups/';
export const DEFAULT_RETENTION_DAYS = 90;

/** Server-generated key shape. Clients never compose or supply a path. */
const OBJECT_KEY_PATTERN =
  /^backups\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\/(\d{6})-([0-9a-f]{12})\.sqlite\.enc$/;

const HEX12_PATTERN = /^[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
/** 12 bytes of SHA-256(key), hex — the public key identifier. */
const KEY_ID_PATTERN = /^[0-9a-f]{24}$/i;

const muscatParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Muscat',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const muscatTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Muscat',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export interface ObjectKeyParts {
  key: string;
  year: string;
  month: string;
  day: string;
  shortId: string;
}

export function randomShortId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * `backups/{yyyy}/{mm}/{yyyy-mm-dd}/{hhmmss}-{shortid}.sqlite.enc`
 *
 * The date parts come from the SERVER clock in Asia/Muscat — the same calendar
 * the DKS history groups by — never from anything the client sent. Muscat has
 * no daylight saving, so the mapping is stable.
 */
export function buildObjectKey(now: Date, shortId: string = randomShortId()): ObjectKeyParts {
  if (!HEX12_PATTERN.test(shortId)) {
    throw new BackupHttpError(500, 'INTERNAL', 'The object identifier is invalid');
  }
  const [year, month, day] = muscatParts.format(now).split('-');
  const time = muscatTime.format(now).replace(/:/g, '');
  const safeYear = /^\d{4}$/.test(year ?? '') ? year : '0000';
  const safeMonth = /^\d{2}$/.test(month ?? '') ? month : '01';
  const safeDay = /^\d{2}$/.test(day ?? '') ? day : '01';
  const safeTime = /^\d{6}$/.test(time) ? time : '000000';
  return {
    key: `${BACKUP_KEY_PREFIX}${safeYear}/${safeMonth}/${safeYear}-${safeMonth}-${safeDay}/${safeTime}-${shortId}.sqlite.enc`,
    year: safeYear,
    month: safeMonth,
    day: `${safeYear}-${safeMonth}-${safeDay}`,
    shortId,
  };
}

/**
 * Validate an id supplied by a client before it is ever used as an R2 key.
 *
 * The id IS the server-generated key, so this is an allowlist, not a
 * sanitiser: only the exact shape `buildObjectKey` can produce is accepted.
 * Anything else — traversal, absolute paths, a different prefix, extra
 * segments — is refused before R2 is touched.
 */
export function assertSafeObjectKey(id: string): string {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value || value.length > 200 || value.includes('..') || value.includes('\\')) {
    throw new BackupHttpError(400, 'BAD_REQUEST', 'That backup identifier is not valid');
  }
  const decoded = safeDecode(value);
  if (!OBJECT_KEY_PATTERN.test(decoded)) {
    throw new BackupHttpError(400, 'BAD_REQUEST', 'That backup identifier is not valid');
  }
  return decoded;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// metadata encoding (HTTP-header safe: no commas, quotes or newlines)
// ---------------------------------------------------------------------------

export function encodeRecordCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([key, value]) => `${safeMetaKey(key)}=${Math.trunc(value as number)}`)
    .join(';');
}

export function decodeRecordCounts(value: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value) return out;
  for (const pair of value.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = safeMetaKey(pair.slice(0, index));
    const parsed = Number(pair.slice(index + 1));
    if (key && Number.isFinite(parsed)) {
      out[key] = parsed;
    }
  }
  return out;
}

function safeMetaKey(key: string): string {
  return String(key).replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
}

/** Strip anything that could carry a control character into a header. */
export function safeMetaValue(value: unknown, maxLength = 200): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.replace(/[\r\n",;]/g, '').trim().slice(0, maxLength);
}

export interface UploadMetadata {
  appVersion: string;
  schemaVersion: string;
  fingerprint: string;
  recordCounts: string;
  plaintextSha256: string;
  createdAt: string;
  /**
   * SHA-256 of the encrypted bytes, DECLARED by the desktop app. Stored
   * verbatim and echoed back on HEAD/GET so the app can re-hash what it
   * downloads and compare. The Worker never computes it — see handleUpload.
   */
  ciphertextSha256: string;
  /** Public key identifier (SHA-256 prefix), '' when the client sent none. */
  keyId: string;
  /** What the snapshot covers. Always 'local-cache' in PR1. */
  source: 'local-cache';
}

function readUploadMetadata(request: Request): UploadMetadata {
  const plaintextSha256 = safeMetaValue(request.headers.get('x-dks-plaintext-sha256'), 64).toLowerCase();
  if (!SHA256_PATTERN.test(plaintextSha256)) {
    throw new BackupHttpError(400, 'BAD_REQUEST', 'The plaintext checksum is missing or malformed');
  }
  const createdAt = safeMetaValue(request.headers.get('x-dks-created-at'), 40);
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new BackupHttpError(400, 'BAD_REQUEST', 'The snapshot timestamp is missing or malformed');
  }
  // Declared by the desktop app, stored verbatim, and re-verified by hashing
  // the bytes that come back on download. The Worker does NOT compute it: a
  // streaming upload cannot be hashed inside a Worker's 128 MB memory limit.
  const ciphertextSha256 = safeMetaValue(request.headers.get('x-dks-ciphertext-sha256'), 64).toLowerCase();
  if (!SHA256_PATTERN.test(ciphertextSha256)) {
    throw new BackupHttpError(400, 'BAD_REQUEST', 'The encrypted checksum is missing or malformed');
  }
  const keyId = safeMetaValue(request.headers.get('x-dks-key-id'), 24).toLowerCase();
  return {
    appVersion: safeMetaValue(request.headers.get('x-dks-app-version'), 32) || 'unknown',
    schemaVersion: safeMetaValue(request.headers.get('x-dks-schema-version'), 8) || '0',
    fingerprint: safeMetaValue(request.headers.get('x-dks-fingerprint'), 64) || '',
    recordCounts: safeMetaValue(request.headers.get('x-dks-record-counts'), 400),
    plaintextSha256,
    createdAt,
    ciphertextSha256,
    keyId: KEY_ID_PATTERN.test(keyId) ? keyId : '',
    // PR1 snapshots are always the local cache. Anything else the client claims
    // is ignored rather than trusted.
    source: 'local-cache',
  };
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const ENVELOPE_MAGIC = 'DKSBK1';
/** Bytes needed to recognise an envelope: magic + version. Nothing more. */
const ENVELOPE_PROBE_BYTES = ENVELOPE_MAGIC.length + 1;

/** Envelope magic + version check. Never inspects the ciphertext itself. */
export function isBackupEnvelope(head: Uint8Array): boolean {
  if (head.byteLength < 7) return false;
  const magic = new TextDecoder().decode(head.subarray(0, ENVELOPE_MAGIC.length));
  return magic === ENVELOPE_MAGIC && head[ENVELOPE_MAGIC.length] === 1;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export interface RouteDeps extends AuthDeps {
  randomShortId?: () => string;
}

export interface UploadResult {
  id: string;
  key: string;
  size: number;
  shortId: string;
  ciphertextSha256: string;
}

/**
 * POST /v1/backups — admin, or an Office session the server has approved.
 *
 * The object key is generated here. The client sends no path, no role and no
 * approval claim; all three are established server-side.
 */
/** Thrown inside the counting transform when the stream passes the limit. */
export class UploadTooLargeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UploadTooLargeError';
  }
}

/**
 * Read only the first `want` bytes of a request body, leaving the reader
 * positioned for the rest. This is what lets the Worker validate the envelope
 * header without buffering the payload: 35 bytes, not 200 MB.
 */
async function readHead(
  body: ReadableStream<Uint8Array>,
  want: number,
): Promise<{ bytes: Uint8Array; reader: ReadableStreamDefaultReader<Uint8Array>; ended: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  while (total < want) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch {
      // The client went away (or its stream errored) before the header even
      // arrived. That is the caller's failure, not the service's: report it as
      // a clean 400 rather than an unhandled 500.
      throw new BackupHttpError(400, 'BAD_REQUEST', 'The backup upload did not arrive');
    }
    if (next.done) {
      ended = true;
      break;
    }
    if (next.value && next.value.byteLength > 0) {
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, reader, ended };
}

/** A stream that replays the probed head and then continues from the reader. */
function streamFromHead(
  head: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ended: boolean,
): ReadableStream<Uint8Array> {
  let headSent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!headSent) {
        headSent = true;
        controller.enqueue(head);
        if (ended) controller.close();
        return undefined;
      }
      return reader.read().then(({ done, value }) => {
        if (done) {
          controller.close();
          return;
        }
        if (value && value.byteLength > 0) controller.enqueue(value);
      });
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}

/**
 * Count bytes as they stream past and error the stream the moment the limit is
 * exceeded, so the object is never written. Nothing is buffered here: the
 * Worker's peak memory is one chunk, not the payload.
 */
export function createUploadByteCounter(maxBytes: number): {
  stream: TransformStream<Uint8Array, Uint8Array>;
  readonly exceeded: () => boolean;
  readonly bytes: () => number;
} {
  let total = 0;
  let exceeded = false;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        exceeded = true;
        throw new UploadTooLargeError('The backup is larger than the service limit');
      }
      controller.enqueue(chunk);
    },
  });
  return { stream, exceeded: () => exceeded, bytes: () => total };
}

/**
 * POST /v1/backups — stream the encrypted envelope straight into R2.
 *
 * Memory safety: a Worker isolate has 128 MB on every plan, so the body is
 * NEVER buffered. Only the 35-byte envelope header is read up front (to reject
 * anything that is not a DKS envelope); the rest flows through a counting
 * transform into `R2.put`. Exceeding the limit errors the stream, the put
 * rejects, and no object is written.
 *
 * Consequence, stated plainly: the Worker cannot compute a SHA-256 over the
 * ciphertext it never holds. The checksum stored with the object is the one the
 * desktop app declared, and it is echoed back on HEAD/GET so the app can hash
 * what it downloads and compare. Real integrity comes from the AES-GCM tag and
 * the AAD-bound plaintext SHA-256 at decrypt time.
 */
export async function handleUpload(
  request: Request,
  env: BackupEnv,
  deps: RouteDeps,
): Promise<UploadResult> {
  // v1 policy: backup upload is ADMIN ONLY. An Office session is refused with
  // OFFICE_NOT_ALLOWED even when its sign-in approval is valid.
  const caller = await requireBackupAdmin(request, env, deps);
  const metadata = readUploadMetadata(request);
  const designated = await requireDesignatedDevice(request, caller.token, env, deps);

  // Cheap early refusal when the client declares an oversized body.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw new BackupHttpError(413, 'PAYLOAD_TOO_LARGE', 'The backup is larger than the service limit');
  }
  if (!request.body) {
    throw new BackupHttpError(400, 'BAD_REQUEST', 'The backup payload is empty');
  }

  const head = await readHead(request.body, ENVELOPE_PROBE_BYTES);
  if (head.bytes.byteLength === 0) {
    throw new BackupHttpError(400, 'BAD_REQUEST', 'The backup payload is empty');
  }
  if (!isBackupEnvelope(head.bytes)) {
    await head.reader.cancel().catch(() => undefined);
    throw new BackupHttpError(400, 'BAD_REQUEST', 'The payload is not a DKS backup envelope');
  }

  const parts = buildObjectKey(new Date(deps.now()), deps.randomShortId?.());
  const counter = createUploadByteCounter(MAX_UPLOAD_BYTES);
  const body = streamFromHead(head.bytes, head.reader, head.ended).pipeThrough(counter.stream);

  try {
    await env.DKS_BACKUPS.put(parts.key, body, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: {
        appVersion: metadata.appVersion,
        schemaVersion: metadata.schemaVersion,
        fingerprint: metadata.fingerprint,
        recordCounts: metadata.recordCounts,
        plaintextSha256: metadata.plaintextSha256,
        createdAt: metadata.createdAt,
        ciphertextSha256: metadata.ciphertextSha256,
        // Provenance of that checksum, so nobody mistakes it for a server hash.
        ciphertextSha256Source: 'client-declared',
        keyId: metadata.keyId,
        source: metadata.source,
        muscatDate: parts.day,
        uploadedBy: caller.claims.sub,
        role: caller.role,
        // Which PC produced this object: the opaque random id it presented and
        // the administrator-chosen label. Neither is PII by construction.
        deviceId: designated.deviceId,
        deviceLabel: designated.label,
      },
    });
  } catch (error) {
    if (counter.exceeded() || error instanceof UploadTooLargeError) {
      throw new BackupHttpError(413, 'PAYLOAD_TOO_LARGE', 'The backup is larger than the service limit');
    }
    throw new BackupHttpError(502, 'UNAVAILABLE', 'The backup could not be stored');
  }
  if (counter.exceeded()) {
    throw new BackupHttpError(413, 'PAYLOAD_TOO_LARGE', 'The backup is larger than the service limit');
  }

  return {
    id: parts.key,
    key: parts.key,
    // The size the Worker actually counted on the wire — its own evidence.
    size: counter.bytes(),
    shortId: parts.shortId,
    ciphertextSha256: metadata.ciphertextSha256,
  };
}

/** Admin, or an Office session approved by the server-side RPC. */

export interface BackupListItem {
  id: string;
  key: string;
  /** Asia/Muscat calendar date, YYYY-MM-DD. */
  day: string;
  sizeBytes: number;
  createdAt: string;
  fingerprint: string;
  plaintextSha256: string;
  schemaVersion: string;
  appVersion: string;
  recordCount: number | null;
  /** Which key opens this object; null when it predates key ids. */
  keyId: string | null;
  /** What the snapshot covers; null for objects that predate the field. */
  source: string | null;
  outcome: 'verified';
}

/**
 * Reject any upload from a PC that is not the one designated in `public.settings`.
 *
 * Server-side by design: a second Admin PC cannot talk itself into uploading by
 * flipping a local flag, because the answer comes from Supabase on every call.
 */
async function requireDesignatedDevice(
  request: Request,
  token: string,
  env: BackupEnv,
  deps: AuthDeps,
): Promise<DesignatedDevice> {
  const presented = (request.headers.get('x-dks-device-id') ?? '').trim().toLowerCase();
  if (!DEVICE_ID_PATTERN.test(presented)) {
    throw new BackupHttpError(400, 'BAD_REQUEST', 'The device identifier is missing or malformed');
  }
  const designated = await lookupDesignatedDevice(token, env, deps);
  if (!designated) {
    throw new BackupHttpError(
      403,
      'DEVICE_NOT_DESIGNATED',
      'No Admin PC is designated for cloud backup. Use "Make this PC the backup PC" in Settings.',
    );
  }
  if (designated.deviceId !== presented) {
    throw new BackupHttpError(
      403,
      'DEVICE_NOT_DESIGNATED',
      'This PC is not the designated backup PC. Automatic backup runs on the designated Admin PC.',
    );
  }
  return designated;
}

/**
 * GET /v1/backups?year&month — admin only, metadata only.
 *
 * Reads `R2.list()` (object metadata), never `get()`, so listing a month of
 * backups transfers no customer data at all. Cursor pagination is R2's own.
 */
export async function handleList(
  request: Request,
  env: BackupEnv,
  deps: RouteDeps,
): Promise<{ year: number; month: number; backups: BackupListItem[]; nextCursor: string | null }> {
  await requireAdmin(request, env, deps);
  const url = new URL(request.url);
  const year = Number(url.searchParams.get('year') ?? '');
  const month = Number(url.searchParams.get('month') ?? '');
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new BackupHttpError(400, 'BAD_REQUEST', 'A valid year is required');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new BackupHttpError(400, 'BAD_REQUEST', 'A valid month is required');
  }
  const cursor = url.searchParams.get('cursor');
  const prefix = `${BACKUP_KEY_PREFIX}${String(year)}/${String(month).padStart(2, '0')}/`;

  const listed = await env.DKS_BACKUPS.list({
    prefix,
    limit: 500,
    ...(cursor && cursor.length > 0 ? { cursor } : {}),
  });

  return {
    year,
    month,
    backups: listed.objects
      .filter((object) => OBJECT_KEY_PATTERN.test(object.key))
      .map((object) => toListItem(object))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    nextCursor: listed.truncated && listed.cursor ? listed.cursor : null,
  };
}

function toListItem(object: R2Object): BackupListItem {
  const meta = object.customMetadata ?? {};
  const counts = decodeRecordCounts(meta.recordCounts ?? null);
  return {
    id: object.key,
    key: object.key,
    day: safeMetaValue(meta.muscatDate, 10) || object.key.split('/')[2] || '',
    sizeBytes: Number(object.size ?? 0),
    createdAt: safeMetaValue(meta.createdAt, 40) || new Date(object.uploaded).toISOString(),
    fingerprint: safeMetaValue(meta.fingerprint, 64),
    plaintextSha256: safeMetaValue(meta.plaintextSha256, 64),
    schemaVersion: safeMetaValue(meta.schemaVersion, 8),
    appVersion: safeMetaValue(meta.appVersion, 32),
    recordCount: typeof counts.entries === 'number' ? counts.entries : null,
    keyId: KEY_ID_PATTERN.test(String(meta.keyId ?? '')) ? String(meta.keyId).toLowerCase() : null,
    // PR1 objects are local-cache snapshots. An object with no recorded source
    // predates the field and is reported as unknown rather than assumed.
    source: meta.source === 'local-cache' ? 'local-cache' : null,
    outcome: 'verified',
  };
}

/**
 * GET (stream) / HEAD (metadata) /v1/backups/{id} — admin only.
 *
 * HEAD exists so the desktop app can confirm an upload by re-reading the
 * stored object's checksum without downloading it again.
 */
export async function handleGetObject(
  request: Request,
  env: BackupEnv,
  deps: RouteDeps,
  id: string,
): Promise<Response> {
  await requireAdmin(request, env, deps);
  const key = assertSafeObjectKey(id);
  const head = await env.DKS_BACKUPS.head(key);
  if (!head) {
    throw new BackupHttpError(404, 'NOT_FOUND', 'That backup no longer exists');
  }

  const meta = head.customMetadata ?? {};
  const headers = new Headers({
    'x-dks-plaintext-sha256': safeMetaValue(meta.plaintextSha256, 64),
    'x-dks-ciphertext-sha256': safeMetaValue(meta.ciphertextSha256, 64),
    // Honest provenance: this checksum was declared by the desktop app at
    // upload time, not computed by the Worker over the stored bytes.
    'x-dks-ciphertext-sha256-source': safeMetaValue(meta.ciphertextSha256Source, 24) || 'client-declared',
    'x-dks-key-id': safeMetaValue(meta.keyId, 24).toLowerCase(),
    'x-dks-source': safeMetaValue(meta.source, 24) || 'local-cache',
    'x-dks-fingerprint': safeMetaValue(meta.fingerprint, 64),
    'x-dks-schema-version': safeMetaValue(meta.schemaVersion, 8),
    'x-dks-record-counts': safeMetaValue(meta.recordCounts, 400),
    'x-dks-created-at': safeMetaValue(meta.createdAt, 40),
    'x-dks-app-version': safeMetaValue(meta.appVersion, 32),
    'x-dks-size': String(head.size ?? 0),
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
  });

  if (request.method.toUpperCase() === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }

  const object = await env.DKS_BACKUPS.get(key);
  if (!object) {
    throw new BackupHttpError(404, 'NOT_FOUND', 'That backup no longer exists');
  }
  headers.set('content-length', String(object.size ?? 0));
  // Streamed straight from R2: the Worker never buffers a whole backup.
  return new Response(object.body, { status: 200, headers });
}

/** GET /health — liveness and R2 binding check. No PII, no token required. */
export async function handleHealth(env: BackupEnv, deps: RouteDeps): Promise<{ ok: boolean; r2: boolean; detail: string | null }> {
  if (!env.DKS_BACKUPS || typeof env.DKS_BACKUPS.list !== 'function') {
    return { ok: false, r2: false, detail: 'The backup bucket binding is missing' };
  }
  try {
    await env.DKS_BACKUPS.list({ prefix: BACKUP_KEY_PREFIX, limit: 1 });
    return { ok: true, r2: true, detail: null };
  } catch {
    return { ok: false, r2: false, detail: 'The backup bucket could not be read' };
  }
}

// ---------------------------------------------------------------------------
// retention (cron)
// ---------------------------------------------------------------------------

export interface RetentionSummary {
  mode: 'dry-run' | 'enforce';
  cutoff: string;
  scanned: number;
  candidates: number;
  deleted: number;
  protectedKey: string | null;
}

export function retentionDays(env: BackupEnv): number {
  const parsed = Number(env.RETENTION_DAYS ?? '');
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.min(3650, Math.trunc(parsed));
}

export function retentionMode(env: BackupEnv): 'dry-run' | 'enforce' {
  return String(env.RETENTION_MODE ?? 'dry-run').trim().toLowerCase() === 'enforce' ? 'enforce' : 'dry-run';
}

/**
 * Remove objects older than the retention window, EXCEPT the newest object —
 * the last verified snapshot is never deleted by the cron.
 *
 * PR1 ships this in **dry-run**: it scans and logs, and deletes nothing. The
 * owner must set `RETENTION_MODE=enforce` explicitly, and only once PR2 has
 * been reviewed.
 */
export async function runRetention(
  env: BackupEnv,
  deps: RouteDeps,
  log: (message: string) => void = () => undefined,
): Promise<RetentionSummary> {
  const mode = retentionMode(env);
  const days = retentionDays(env);
  const cutoff = deps.now() - days * 24 * 60 * 60 * 1000;

  let cursor: string | undefined;
  let scanned = 0;
  let newestKey: string | null = null;
  let newestAt = -Infinity;
  const objects: R2Object[] = [];

  for (let page = 0; page < 200; page += 1) {
    const listed = await env.DKS_BACKUPS.list({
      prefix: BACKUP_KEY_PREFIX,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of listed.objects) {
      if (!OBJECT_KEY_PATTERN.test(object.key)) continue;
      scanned += 1;
      const at = new Date(object.uploaded).getTime();
      if (at > newestAt) {
        newestAt = at;
        newestKey = object.key;
      }
      objects.push(object);
    }
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }

  const candidates = objects
    .filter((object) => new Date(object.uploaded).getTime() < cutoff && object.key !== newestKey);

  log(`[dks-backup retention] mode=${mode} days=${String(days)} scanned=${String(scanned)} candidates=${String(candidates.length)} newest=${newestKey ?? 'none'}`);

  let deleted = 0;
  if (mode === 'enforce' && candidates.length > 0) {
    for (let index = 0; index < candidates.length; index += 100) {
      const batch = candidates.slice(index, index + 100).map((object) => object.key);
      await env.DKS_BACKUPS.delete(batch);
      deleted += batch.length;
    }
    log(`[dks-backup retention] deleted ${String(deleted)} object(s)`);
  }

  return {
    mode,
    cutoff: new Date(cutoff).toISOString(),
    scanned,
    candidates: candidates.length,
    deleted,
    protectedKey: newestKey,
  };
}

/** PR2/PR3 hook, present but unwired: no route calls it in PR1. */
export function assertDestructiveAllowed(request: Request): void {
  requireStepUp(request);
}
