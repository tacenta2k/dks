import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type {
  BackupHealthResult,
  BackupHistoryEntry,
  BackupListQuery,
  BackupListResult,
  BackupOutcome,
  BackupSessionCredential,
} from './backup-types';
import { isKeyId, looksLikeBackupEnvelope, sha256Hex, type BackupMetadata } from './backup-crypto';

/**
 * The only place DKS talks to the Cloudflare backup Worker.
 *
 * It runs in the MAIN process. The renderer never calls the Worker, never sees
 * R2 keys (there are none client-side) and never receives a role it could
 * invent: the Worker re-verifies the Supabase JWT and looks the role up itself.
 */

export const BACKUP_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const SHORT_TIMEOUT_MS = 15_000;

export type BackupApiErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'PAYLOAD_TOO_LARGE'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'CHECKSUM_MISMATCH'
  | 'NETWORK'
  | 'SERVER'
  | 'STEP_UP_REQUIRED'
  | 'UNAVAILABLE';

export class BackupApiError extends Error {
  public readonly code: BackupApiErrorCode;
  public readonly status: number | null;

  public constructor(code: BackupApiErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'BackupApiError';
    this.code = code;
    this.status = status;
  }
}

export interface UploadedBackup {
  id: string;
  key: string;
  size: number;
  /** SHA-256 of the bytes the server stored, hex. */
  ciphertextSha256: string;
}

export interface BackupApiClientOptions {
  workerUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  appVersion?: string;
  /**
   * This PC's opaque random id. Sent as `x-dks-device-id`; the Worker refuses
   * the upload unless it matches the Admin-designated device recorded in
   * Supabase `public.settings`.
   */
  deviceId?: string;
}

/** Accept only an https Worker URL; anything else is refused before any I/O. */
/**
 * The only object keys DKS will ever ask the Worker for are the ones the
 * Worker itself issued. Mirrors the pattern enforced server-side in
 * `cloudflare-backup/src/routes.ts`.
 */
export const BACKUP_OBJECT_KEY_PATTERN =
  /^backups\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\/\d{6}-[0-9a-f]{12}\.sqlite\.enc$/;

/**
 * Reject anything that is not a server-issued key before it leaves this PC.
 * `encodeURIComponent` already neutralises traversal on the wire; this stops a
 * tampered renderer from probing arbitrary R2 paths at all, and keeps the
 * failure local and obvious instead of a 404 from the cloud.
 */
export function assertSafeObjectKey(id: unknown): string {
  if (typeof id !== 'string' || !BACKUP_OBJECT_KEY_PATTERN.test(id.trim())) {
    throw new BackupApiError('BAD_REQUEST', 'That is not a backup DKS created');
  }
  return id.trim();
}

/**
 * Record-count header codec.
 *
 * The wire format is `entries=1200;columns=3` — the exact shape the Worker
 * writes into R2 custom metadata and echoes back on `HEAD`/`GET`
 * (`cloudflare-backup/src/routes.ts`: `encodeRecordCounts`/`decodeRecordCounts`).
 * JSON is NOT usable here: R2 custom metadata is plain strings and the Worker
 * strips anything that is not `[A-Za-z0-9_]` from a key, so braces, quotes and
 * colons would be mangled. Covered by tests/backup-client-contract.test.ts.
 */
export function encodeRecordCounts(counts: Record<string, number> | undefined | null): string {
  if (!counts || typeof counts !== 'object') return '';
  return Object.entries(counts)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([key, value]) => `${safeCountKey(key)}=${Math.trunc(value as number)}`)
    .filter((pair) => pair.length > 0 && !pair.startsWith('='))
    .join(';');
}

export function decodeRecordCounts(value: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value) return out;
  for (const pair of String(value).split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = safeCountKey(pair.slice(0, index));
    const parsed = Number(pair.slice(index + 1));
    if (key && Number.isFinite(parsed)) {
      out[key] = parsed;
    }
  }
  return out;
}

function safeCountKey(key: string): string {
  return String(key).replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
}

export function normalizeWorkerUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new BackupApiError('NOT_CONFIGURED', 'The backup service address is not set');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BackupApiError('NOT_CONFIGURED', 'The backup service address is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new BackupApiError('NOT_CONFIGURED', 'The backup service address must use https');
  }
  if (!parsed.hostname || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
    throw new BackupApiError('NOT_CONFIGURED', 'The backup service address is not reachable');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turn any Worker response into a BackupApiError. The Worker's error body is
 * always `{ error: { code, message } }`; this never surfaces a request body,
 * a token or a customer value.
 */
function errorFromBody(status: number, body: unknown): BackupApiError {
  const payload = isRecord(body) && isRecord(body.error) ? body.error : null;
  const rawCode = typeof payload?.code === 'string' ? payload.code.toUpperCase() : '';
  const message = typeof payload?.message === 'string' && payload.message.trim()
    ? payload.message.trim().slice(0, 240)
    : `The backup service returned ${status}`;
  const code: BackupApiErrorCode = (
    ['UNAUTHORIZED', 'FORBIDDEN', 'PAYLOAD_TOO_LARGE', 'BAD_REQUEST', 'NOT_FOUND',
      'CHECKSUM_MISMATCH', 'STEP_UP_REQUIRED', 'UNAVAILABLE'].includes(rawCode)
      ? rawCode
      : status === 401
        ? 'UNAUTHORIZED'
        : status === 403
          ? 'FORBIDDEN'
          : status === 404
            ? 'NOT_FOUND'
            : status === 413
              ? 'PAYLOAD_TOO_LARGE'
              : status >= 500
                ? 'SERVER'
                : 'BAD_REQUEST'
  ) as BackupApiErrorCode;
  return new BackupApiError(code, message, status);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

export class BackupApiClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly appVersion: string;
  private readonly deviceId: string;

  public constructor(options: BackupApiClientOptions) {
    this.baseUrl = normalizeWorkerUrl(options.workerUrl);
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.appVersion = options.appVersion ?? '0.0.0';
    this.deviceId = typeof options.deviceId === 'string' ? options.deviceId.trim().toLowerCase() : '';
    if (!options.accessToken || !options.accessToken.trim()) {
      throw new BackupApiError('UNAUTHORIZED', 'Sign in to DKS before using cloud backup');
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.accessToken}`,
      'x-dks-app-version': this.appVersion,
      ...extra,
    };
  }

  private async request(
    init: {
      path: string;
      method?: string;
      /** `RequestInit['body']` — the node lib has no DOM `BodyInit` type. */
      body?: RequestInit['body'];
      headers?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${init.path}`, {
        method: init.method ?? 'GET',
        headers: this.headers(init.headers),
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
      return response;
    } catch (caught) {
      const aborted = caught instanceof Error && caught.name === 'AbortError';
      throw new BackupApiError(
        'NETWORK',
        aborted
          ? 'The backup service did not respond in time'
          : 'DKS could not reach the backup service. Check the internet connection.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /health — liveness plus the R2 binding check. No PII in either direction. */
  public async healthCheck(): Promise<BackupHealthResult> {
    try {
      const response = await this.request({ path: '/health', timeoutMs: SHORT_TIMEOUT_MS });
      const body = await readJson(response);
      if (!response.ok) {
        return { ok: false, reachable: true, r2Bound: false, detail: errorFromBody(response.status, body).message };
      }
      const record = isRecord(body) ? body : {};
      return {
        ok: record.r2 === true,
        reachable: true,
        r2Bound: record.r2 === true,
        detail: typeof record.detail === 'string' ? record.detail : null,
      };
    } catch (caught) {
      const message = caught instanceof BackupApiError ? caught.message : 'The backup service is unreachable';
      return { ok: false, reachable: false, r2Bound: false, detail: message };
    }
  }

  /**
   * POST /v1/backups — upload one encrypted envelope.
   *
   * The server owns the object key; the client sends no path. The response
   * carries the SHA-256 of the bytes the server stored, which the caller must
   * match before treating the backup as verified.
   */
  public async upload(
    payload: Buffer,
    metadata: BackupMetadata,
  ): Promise<UploadedBackup> {
    if (payload.byteLength > BACKUP_UPLOAD_MAX_BYTES) {
      throw new BackupApiError('PAYLOAD_TOO_LARGE', 'The encrypted backup is larger than the service limit');
    }
    if (!looksLikeBackupEnvelope(payload)) {
      throw new BackupApiError('BAD_REQUEST', 'The encrypted backup is not a valid DKS envelope');
    }

    const response = await this.request({
      path: '/v1/backups',
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-dks-plaintext-sha256': metadata.plaintextSha256,
        'x-dks-fingerprint': metadata.fingerprint,
        'x-dks-schema-version': String(metadata.schemaVersion),
        'x-dks-record-counts': encodeRecordCounts(metadata.recordCounts),
        'x-dks-created-at': metadata.createdAt,
        // The Worker streams straight to R2 and cannot hash a 200 MB body
        // inside a 128 MB isolate, so the ciphertext checksum is declared here
        // and re-verified by hashing the bytes that come back on download.
        'x-dks-ciphertext-sha256': sha256Hex(payload),
        'x-dks-key-id': metadata.keyId,
        'x-dks-source': metadata.source,
        // The Worker checks this against the designated Admin PC before storing
        // anything, so a second PC cannot start its own backup lineage.
        'x-dks-device-id': this.deviceId,
      },
      body: new Uint8Array(payload),
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw errorFromBody(response.status, body);
    }
    if (!isRecord(body) || typeof body.key !== 'string' || typeof body.size !== 'number') {
      throw new BackupApiError('SERVER', 'The backup service returned an unusable response');
    }
    return {
      id: typeof body.id === 'string' ? body.id : body.key,
      key: body.key,
      size: body.size,
      ciphertextSha256: typeof body.ciphertextSha256 === 'string' ? body.ciphertextSha256 : '',
    };
  }

  /**
   * HEAD /v1/backups/{id} — metadata only. Used both to confirm an upload
   * (independent re-read of the stored object) and to feed the test-restore
   * drill the checksum it must match.
   */
  private async head(id: string): Promise<Record<string, string>> {
    const response = await this.request({
      path: `/v1/backups/${encodeURIComponent(id)}`,
      method: 'HEAD',
      timeoutMs: SHORT_TIMEOUT_MS,
    });
    if (!response.ok) {
      const body = await readJson(response);
      throw errorFromBody(response.status, body);
    }
    const out: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith('x-dks-')) {
        out[key.toLowerCase()] = value;
      }
    });
    return out;
  }

  /**
   * Re-read the stored object's metadata and compare it with what was sent.
   *
   * Honest scope: the Worker streams uploads straight to R2 and therefore does
   * NOT compute its own SHA-256 of the ciphertext (a 200 MB hash will not fit
   * in a 128 MB Worker isolate). The value compared here is the one DKS
   * declared at upload time, so this proves the object exists at a
   * server-generated key with the expected size and unchanged metadata — it is
   * NOT independent proof of the stored bytes. The real byte-level check
   * happens on download: `download()` hashes what R2 actually returned, and the
   * drill compares that against this stored value before decrypting.
   */
  public async verifyStored(
    id: string,
    expectedCiphertextSha256: string,
  ): Promise<{ ok: boolean; size: number | null; checksumSource: 'client-declared' }> {
    const headers = await this.head(id);
    const storedSha = headers['x-dks-ciphertext-sha256'] ?? '';
    const sizeHeader = headers['x-dks-size'];
    const size = sizeHeader !== undefined && Number.isFinite(Number(sizeHeader)) ? Number(sizeHeader) : null;
    return {
      ok: storedSha.length > 0 && storedSha.toLowerCase() === expectedCiphertextSha256.toLowerCase(),
      size,
      checksumSource: 'client-declared',
    };
  }

  /** Metadata the Worker stored with an object, as the envelope's metadata. */
  public async listMetadataFor(id: string): Promise<{
    metadata: BackupMetadata | null;
    size: number | null;
    /** Client-declared at upload time; re-hashed locally on download. */
    ciphertextSha256: string | null;
  }> {
    const headers = await this.head(id);
    const plaintextSha256 = headers['x-dks-plaintext-sha256'] ?? '';
    const ciphertextSha256 = headers['x-dks-ciphertext-sha256'] ?? '';
    if (!/^[0-9a-f]{64}$/i.test(plaintextSha256)) {
      return { metadata: null, size: null, ciphertextSha256: null };
    }
    const recordCounts = decodeRecordCounts(headers['x-dks-record-counts'] ?? null);
    const schemaVersion = Number(headers['x-dks-schema-version'] ?? '0');
    const sizeHeader = headers['x-dks-size'];
    const keyId = (headers['x-dks-key-id'] ?? '').toLowerCase();
    return {
      metadata: {
        plaintextSha256: plaintextSha256.toLowerCase(),
        fingerprint: headers['x-dks-fingerprint'] ?? '',
        appVersion: headers['x-dks-app-version'] ?? '',
        schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : 0,
        recordCounts,
        createdAt: headers['x-dks-created-at'] ?? '',
        // An object uploaded before key ids existed has no id; that is reported
        // rather than guessed, so a mismatch can never look like a match.
        keyId: isKeyId(keyId) ? keyId : '',
        source: 'local-cache',
      },
      size: sizeHeader !== undefined && Number.isFinite(Number(sizeHeader)) ? Number(sizeHeader) : null,
      ciphertextSha256: /^[0-9a-f]{64}$/i.test(ciphertextSha256) ? ciphertextSha256.toLowerCase() : null,
    };
  }

  /** GET /v1/backups?year&month — metadata only; the Worker never streams bodies here. */
  public async list(query: BackupListQuery): Promise<BackupListResult> {
    const params = new URLSearchParams({ year: String(query.year), month: String(query.month) });
    if (query.cursor) {
      params.set('cursor', query.cursor);
    }
    const response = await this.request({
      path: `/v1/backups?${params.toString()}`,
      timeoutMs: SHORT_TIMEOUT_MS,
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw errorFromBody(response.status, body);
    }
    const entries = isRecord(body) && Array.isArray(body.backups) ? body.backups : [];
    return {
      year: query.year,
      month: query.month,
      entries: entries.filter(isRecord).map((row): BackupHistoryEntry => ({
        day: typeof row.day === 'string' ? row.day : '',
        sizeBytes: typeof row.sizeBytes === 'number' ? row.sizeBytes : null,
        outcome: (typeof row.outcome === 'string' ? row.outcome : 'verified') as BackupOutcome,
        objectKey: typeof row.objectKey === 'string'
          ? row.objectKey
          : typeof row.key === 'string'
            ? row.key
            : null,
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
        recordCount: typeof row.recordCount === 'number' ? row.recordCount : null,
        keyId: isKeyId(row.keyId) ? String(row.keyId).toLowerCase() : null,
        source: typeof row.source === 'string' && row.source.length > 0 ? row.source : null,
      })),
      nextCursor: isRecord(body) && typeof body.nextCursor === 'string' ? body.nextCursor : null,
    };
  }

  /**
   * GET /v1/backups/{id} — stream the encrypted object straight to `destination`
   * so a large backup never has to fit in memory.
   */
  public async download(id: string, destination: string): Promise<{ sizeBytes: number; sha256: string }> {
    const objectKey = assertSafeObjectKey(id);
    const response = await this.request({ path: `/v1/backups/${encodeURIComponent(objectKey)}` });
    if (!response.ok) {
      const body = await readJson(response);
      throw errorFromBody(response.status, body);
    }
    if (!response.body) {
      throw new BackupApiError('SERVER', 'The backup service returned an empty body');
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const sink = fs.createWriteStream(destination);
    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            sizeBytes += chunk.byteLength;
            hash.update(chunk);
            yield chunk;
          }
        },
        sink,
      );
    } catch {
      safeRemove(destination);
      throw new BackupApiError('NETWORK', 'The backup download did not finish');
    }

    return { sizeBytes, sha256: hash.digest('hex') };
  }

  /** Latest verified object key for the test-restore drill, newest first. */
  public async latestObjectKey(now: () => Date = () => new Date()): Promise<string | null> {
    const current = now();
    for (let back = 0; back < 3; back += 1) {
      const probe = new Date(Date.UTC(
        current.getUTCFullYear(),
        current.getUTCMonth() - back,
        1,
      ));
      const result = await this.list({ year: probe.getUTCFullYear(), month: probe.getUTCMonth() + 1 });
      const verified = result.entries
        .filter((entry) => entry.outcome === 'verified' && entry.objectKey)
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      if (verified.length > 0) {
        return verified[0].objectKey as string;
      }
    }
    return null;
  }
}

export function safeRemove(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  } catch {
    // Temp-file cleanup is best effort.
  }
}

export function credentialFrom(input: unknown): BackupSessionCredential | null {
  if (!isRecord(input)) return null;
  const role = input.role;
  const accessToken = input.accessToken;
  const workerUrl = input.workerUrl;
  if ((role !== 'admin' && role !== 'office') || typeof accessToken !== 'string' || !accessToken.trim()) {
    return null;
  }
  return {
    role,
    accessToken,
    ...(typeof workerUrl === 'string' && workerUrl.trim() ? { workerUrl } : {}),
  };
}
