import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomFillSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Cloud backup envelope — version 1.
 *
 *   bytes  0..5   magic   "DKSBK1"
 *   byte   6      version 0x01
 *   bytes  7..18  iv      12 random bytes (96-bit GCM IV, fresh per backup)
 *   bytes 19..34  tag     16-byte GCM authentication tag
 *   bytes 35..    ciphertext
 *
 * The SHA-256 of the PLAINTEXT travels in the metadata (never inside the file),
 * which is what lets a test-restore drill prove the decrypted bytes are the
 * exact database that was encrypted — not merely "something GCM accepted".
 *
 * The metadata is bound to the ciphertext through the GCM AAD, so swapping a
 * checksum or a fingerprint onto a different ciphertext fails authentication.
 */
export const BACKUP_ENVELOPE_MAGIC = 'DKSBK1';
export const BACKUP_ENVELOPE_VERSION = 1;
export const BACKUP_IV_BYTES = 12;
export const BACKUP_TAG_BYTES = 16;
export const BACKUP_HEADER_BYTES = BACKUP_ENVELOPE_MAGIC.length + 1 + BACKUP_IV_BYTES + BACKUP_TAG_BYTES;

export const BACKUP_KEY_BYTES = 32;

/** Metadata that travels next to (never inside) the encrypted payload. */
/**
 * What a snapshot actually covers.
 *
 * PR1 is ALWAYS 'local-cache': a point-in-time copy of the local SQLite cache
 * on the PC that made it. It is NOT an authoritative read of the Supabase
 * database, and nothing in this codebase may claim otherwise. 'authoritative'
 * is reserved for a future phase that reconciles Supabase (with pagination)
 * before snapshotting.
 */
export type BackupSource = 'local-cache';

export const BACKUP_SOURCE: BackupSource = 'local-cache';

/** Plain-English label used in the UI and in backup metadata. */
export const BACKUP_SOURCE_LABEL = 'Local cache on this PC — not a full Supabase backup';

export interface BackupMetadata {
  /** Plaintext SHA-256, lowercase hex. */
  plaintextSha256: string;
  fingerprint: string;
  appVersion: string;
  schemaVersion: number;
  recordCounts: Record<string, number>;
  /** ISO-8601 instant the snapshot was taken. */
  createdAt: string;
  /**
   * Identity of the key that encrypted this backup: the first 12 bytes of
   * SHA-256(key) as hex. This is a hash prefix, NOT the key, and it cannot be
   * reversed. It exists so an administrator can tell WHICH recovery key a
   * given backup needs — several PCs can each hold their own key.
   */
  keyId: string;
  /** What the snapshot covers. Always 'local-cache' in PR1. */
  source: BackupSource;
}

export interface EncryptedBackup {
  /** Complete DKSBK1 envelope, ready to upload verbatim. */
  payload: Buffer;
  metadata: BackupMetadata;
  /** SHA-256 of `payload` (lowercase hex) — confirmed against the stored object. */
  ciphertextSha256: string;
  plaintextBytes: number;
}

export interface DecryptResult {
  plaintext: Buffer;
  metadata: BackupMetadata;
}

/**
 * `safeStorage` is the only supported place the backup key may live at rest:
 * DPAPI on Windows, Keychain on macOS, libsecret on Linux. A plaintext key
 * file is never written, and setup fails when encryption is unavailable.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Lazily loaded so vitest can inject a stub without the Electron runtime. */
export function tryLoadSafeStorage(): SafeStorageLike | null {
  try {
    const electron = require('electron') as { safeStorage?: SafeStorageLike };
    const storage = electron.safeStorage;
    if (!storage || typeof storage.isEncryptionAvailable !== 'function') {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

export function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalMetadata(metadata: BackupMetadata): string {
  return JSON.stringify({
    plaintextSha256: metadata.plaintextSha256,
    fingerprint: metadata.fingerprint,
    appVersion: metadata.appVersion,
    schemaVersion: metadata.schemaVersion,
    recordCounts: metadata.recordCounts,
    createdAt: metadata.createdAt,
    keyId: metadata.keyId,
    source: metadata.source,
  });
}

function authTagAAD(metadata: BackupMetadata): Buffer {
  // Binds the values that matter for verification: the declared plaintext
  // checksum, the declared schema version, and the identity of the key used.
  // Re-pairing any of them with another ciphertext fails the GCM tag check, so
  // an envelope cannot be relabelled as belonging to a different key.
  return Buffer.from(
    `${BACKUP_ENVELOPE_MAGIC}|${BACKUP_ENVELOPE_VERSION}|${metadata.plaintextSha256}|${metadata.schemaVersion}|${metadata.keyId}`,
    'utf8',
  );
}

export function isBackupMetadata(value: unknown): value is BackupMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BackupMetadata>;
  return typeof candidate.plaintextSha256 === 'string'
    && /^[0-9a-f]{64}$/.test(candidate.plaintextSha256)
    && typeof candidate.fingerprint === 'string'
    && typeof candidate.appVersion === 'string'
    && typeof candidate.schemaVersion === 'number'
    && typeof candidate.recordCounts === 'object'
    && candidate.recordCounts !== null
    && typeof candidate.createdAt === 'string'
    && typeof candidate.keyId === 'string'
    && /^[0-9a-f]{24}$/.test(candidate.keyId)
    && candidate.source === 'local-cache';
}

export class BackupCryptoError extends Error {
  public readonly code: BackupCryptoErrorCode;

  public constructor(code: BackupCryptoErrorCode, message: string) {
    super(message);
    this.name = 'BackupCryptoError';
    this.code = code;
  }
}

export type BackupCryptoErrorCode =
  | 'BAD_MAGIC'
  | 'BAD_VERSION'
  | 'TRUNCATED'
  | 'BAD_METADATA'
  | 'AUTH_FAILED'
  | 'CHECKSUM_MISMATCH'
  | 'KEY_UNAVAILABLE'
  | 'KEY_INVALID';

/** Generate the one-and-only 256-bit backup key for this PC. */
export function generateBackupKey(): Buffer {
  const key = Buffer.alloc(BACKUP_KEY_BYTES);
  randomFillSync(key);
  return key;
}

/** The value shown once in the setup wizard: 32 bytes, base64, no padding loss. */
export function formatRecoveryKey(key: Buffer): string {
  if (key.length !== BACKUP_KEY_BYTES) {
    throw new BackupCryptoError('KEY_INVALID', 'The backup key must be exactly 32 bytes');
  }
  return key.toString('base64');
}

/** Parse a recovery key typed by the administrator. Whitespace-insensitive. */
export function parseRecoveryKey(text: string): Buffer {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    throw new BackupCryptoError('KEY_INVALID', 'Enter the recovery key');
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(normalized, 'base64');
  } catch {
    throw new BackupCryptoError('KEY_INVALID', 'That recovery key is not readable');
  }
  if (decoded.length !== BACKUP_KEY_BYTES) {
    throw new BackupCryptoError('KEY_INVALID', 'That recovery key is the wrong length');
  }
  return decoded;
}

/** Stored locally instead of the key, to verify a typed recovery key. */
export function keyVerificationHash(key: Buffer): string {
  return sha256Hex(key);
}

/** How many bytes of SHA-256(key) form the public key identifier. */
export const BACKUP_KEY_ID_BYTES = 12;

/**
 * Public identifier for a backup key: the first 12 bytes of SHA-256(key), hex.
 *
 * One-way. Publishing it is safe — it lets an administrator match a backup to
 * the recovery key that opens it — and it never reveals the key.
 */
export function keyIdFromKey(key: Buffer): string {
  if (key.length !== BACKUP_KEY_BYTES) {
    throw new BackupCryptoError('KEY_INVALID', 'The backup key must be exactly 32 bytes');
  }
  return createHash('sha256').update(key).digest().subarray(0, BACKUP_KEY_ID_BYTES).toString('hex');
}

/** Same identifier derived from the stored verification hash (no key needed). */
export function keyIdFromStoredHash(storedHash: string | null | undefined): string | null {
  const value = String(storedHash ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  return value.slice(0, BACKUP_KEY_ID_BYTES * 2);
}

export function isKeyId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{24}$/.test(value);
}

/** Constant-time comparison of a typed recovery key against the stored hash. */
export function matchesStoredKey(candidate: Buffer, storedHash: string): boolean {
  const expected = Buffer.from(String(storedHash ?? ''), 'utf8');
  const actual = Buffer.from(keyVerificationHash(candidate), 'utf8');
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

export function encryptBackup(
  plaintext: Buffer,
  key: Buffer,
  metadata: BackupMetadata,
): EncryptedBackup {
  if (key.length !== BACKUP_KEY_BYTES) {
    throw new BackupCryptoError('KEY_INVALID', 'The backup key must be exactly 32 bytes');
  }

  // Bind the FINAL metadata (including the checksum we are about to publish) to
  // the ciphertext. Doing this from the caller's object — whose
  // `plaintextSha256` is still empty — would make every envelope undecryptable.
  const boundMetadata: BackupMetadata = { ...metadata, plaintextSha256: sha256Hex(plaintext) };

  const iv = randomBytes(BACKUP_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(authTagAAD(boundMetadata));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== BACKUP_TAG_BYTES) {
    throw new BackupCryptoError('AUTH_FAILED', 'Encryption did not produce an authentication tag');
  }

  const payload = Buffer.concat([
    Buffer.from(BACKUP_ENVELOPE_MAGIC, 'ascii'),
    Buffer.from([BACKUP_ENVELOPE_VERSION]),
    iv,
    tag,
    ciphertext,
  ]);

  return {
    payload,
    metadata: boundMetadata,
    ciphertextSha256: sha256Hex(payload),
    plaintextBytes: plaintext.byteLength,
  };
}

/**
 * Verify the envelope header, authenticate the ciphertext and confirm the
 * declared plaintext checksum. Every failure mode is distinct so the UI can
 * say something true ("wrong key" vs "the file is damaged").
 */
export function decryptBackup(
  payload: Buffer,
  key: Buffer,
  metadata: BackupMetadata,
): DecryptResult {
  if (key.length !== BACKUP_KEY_BYTES) {
    throw new BackupCryptoError('KEY_INVALID', 'The backup key must be exactly 32 bytes');
  }
  if (!isBackupMetadata(metadata)) {
    throw new BackupCryptoError('BAD_METADATA', 'The backup metadata is missing or malformed');
  }
  if (payload.byteLength < BACKUP_HEADER_BYTES) {
    throw new BackupCryptoError('TRUNCATED', 'The backup file is truncated');
  }
  if (payload.subarray(0, BACKUP_ENVELOPE_MAGIC.length).toString('ascii') !== BACKUP_ENVELOPE_MAGIC) {
    throw new BackupCryptoError('BAD_MAGIC', 'That file is not a DKS backup');
  }
  const version = payload.readUInt8(BACKUP_ENVELOPE_MAGIC.length);
  if (version !== BACKUP_ENVELOPE_VERSION) {
    throw new BackupCryptoError('BAD_VERSION', `Unsupported backup format version ${version}`);
  }

  const offset = BACKUP_ENVELOPE_MAGIC.length + 1;
  const iv = payload.subarray(offset, offset + BACKUP_IV_BYTES);
  const tag = payload.subarray(offset + BACKUP_IV_BYTES, offset + BACKUP_IV_BYTES + BACKUP_TAG_BYTES);
  const ciphertext = payload.subarray(offset + BACKUP_IV_BYTES + BACKUP_TAG_BYTES);

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(authTagAAD(metadata));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM cannot distinguish a wrong key from tampered bytes; both must be
    // reported as "cannot be decrypted", never as success.
    throw new BackupCryptoError('AUTH_FAILED', 'The backup could not be decrypted with this key');
  }

  const actual = sha256Hex(plaintext);
  const expected = Buffer.from(metadata.plaintextSha256, 'utf8');
  const got = Buffer.from(actual, 'utf8');
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    throw new BackupCryptoError(
      'CHECKSUM_MISMATCH',
      'The backup decrypted but its contents do not match the recorded checksum',
    );
  }

  return { plaintext, metadata };
}

/** True when `payload` starts with the DKSBK1 magic and a known version. */
export function looksLikeBackupEnvelope(payload: Buffer): boolean {
  if (payload.byteLength < BACKUP_HEADER_BYTES) return false;
  if (payload.subarray(0, BACKUP_ENVELOPE_MAGIC.length).toString('ascii') !== BACKUP_ENVELOPE_MAGIC) {
    return false;
  }
  return payload.readUInt8(BACKUP_ENVELOPE_MAGIC.length) === BACKUP_ENVELOPE_VERSION;
}

/** Wrap the key for at-rest storage. Throws when DPAPI/Keychain is unavailable. */
export function wrapKeyForStorage(key: Buffer, storage: SafeStorageLike | null): Buffer {
  if (!storage || storage.isEncryptionAvailable() !== true) {
    throw new BackupCryptoError(
      'KEY_UNAVAILABLE',
      'This PC cannot protect the backup key with the operating system key store',
    );
  }
  return storage.encryptString(key.toString('base64'));
}

export function unwrapStoredKey(wrapped: Buffer, storage: SafeStorageLike | null): Buffer {
  if (!storage || storage.isEncryptionAvailable() !== true) {
    throw new BackupCryptoError(
      'KEY_UNAVAILABLE',
      'This PC cannot read the protected backup key from the operating system key store',
    );
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(storage.decryptString(wrapped), 'base64');
  } catch {
    throw new BackupCryptoError('KEY_INVALID', 'The stored backup key could not be read');
  }
  if (decoded.length !== BACKUP_KEY_BYTES) {
    throw new BackupCryptoError('KEY_INVALID', 'The stored backup key is the wrong length');
  }
  return decoded;
}

/** Test helper: a deterministic 32-byte key. Never used in production paths. */
export function fixedKeyForTests(seed = 'dks-test'): Buffer {
  const key = createHash('sha256').update(seed).digest();
  return Buffer.from(key.subarray(0, BACKUP_KEY_BYTES));
}
