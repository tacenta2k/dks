// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  BACKUP_ENVELOPE_MAGIC,
  BACKUP_ENVELOPE_VERSION,
  BACKUP_HEADER_BYTES,
  BACKUP_KEY_BYTES,
  decryptBackup,
  encryptBackup,
  fixedKeyForTests,
  formatRecoveryKey,
  generateBackupKey,
  isBackupMetadata,
  keyIdFromKey,
  keyIdFromStoredHash,
  keyVerificationHash,
  looksLikeBackupEnvelope,
  matchesStoredKey,
  parseRecoveryKey,
  sha256Hex,
  unwrapStoredKey,
  wrapKeyForStorage,
  type BackupMetadata,
  type SafeStorageLike,
} from '../electron/main/backup-crypto';

function metadata(overrides: Partial<BackupMetadata> = {}): BackupMetadata {
  return {
    plaintextSha256: '',
    fingerprint: 'a'.repeat(64),
    appVersion: '0.1.11',
    schemaVersion: 4,
    recordCounts: { entries: 3, columns: 2 },
    createdAt: '2026-10-31T06:00:00.000Z',
    keyId: 'ab'.repeat(12),
    source: 'local-cache',
    ...overrides,
  };
}

describe('key identity is bound into the envelope', () => {
  it('refuses to decrypt an envelope whose metadata names a different key id', () => {
    const key = fixedKeyForTests('dks-envelope');
    const encrypted = encryptBackup(Buffer.from('payload'), key, metadata());
    const relabelled = metadata({ keyId: 'cd'.repeat(12) });

    // Same key, same ciphertext — only the claimed key id differs, and the GCM
    // tag (whose AAD includes the key id) rejects it.
    expect(() => decryptBackup(encrypted.payload, key, relabelled)).toThrow();
    expect(() => decryptBackup(encrypted.payload, key, encrypted.metadata)).not.toThrow();
    expect(encrypted.metadata.keyId).toBe('ab'.repeat(12));
    expect(encrypted.metadata.source).toBe('local-cache');
  });

  it('derives a stable, one-way key id from a key', () => {
    const a = fixedKeyForTests('pc-a');
    const b = fixedKeyForTests('pc-b');
    expect(keyIdFromKey(a)).toBe(keyIdFromKey(a));
    expect(keyIdFromKey(a)).not.toBe(keyIdFromKey(b));
    expect(keyIdFromKey(a)).toMatch(/^[0-9a-f]{24}$/);
    // The id is a prefix of the stored verification hash, so it reveals nothing.
    expect(keyVerificationHash(a).startsWith(keyIdFromKey(a))).toBe(true);
    expect(keyIdFromStoredHash(keyVerificationHash(a))).toBe(keyIdFromKey(a));
    expect(keyIdFromStoredHash('nope')).toBeNull();
    expect(() => keyIdFromKey(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

const KEY = fixedKeyForTests('dks-envelope');
const PLAINTEXT = Buffer.from('SQLite format 3 — synthetic backup payload for tests');

describe('backup envelope (DKSBK1)', () => {
  it('round-trips a snapshot through AES-256-GCM', () => {
    const encrypted = encryptBackup(PLAINTEXT, KEY, metadata());
    expect(encrypted.metadata.plaintextSha256).toBe(sha256Hex(PLAINTEXT));
    expect(encrypted.plaintextBytes).toBe(PLAINTEXT.byteLength);

    const decrypted = decryptBackup(encrypted.payload, KEY, encrypted.metadata);
    expect(decrypted.plaintext.equals(PLAINTEXT)).toBe(true);
  });

  it('writes the documented header layout: magic, version, iv, tag, ciphertext', () => {
    const { payload } = encryptBackup(PLAINTEXT, KEY, metadata());
    expect(payload.subarray(0, 6).toString('ascii')).toBe(BACKUP_ENVELOPE_MAGIC);
    expect(payload.readUInt8(6)).toBe(BACKUP_ENVELOPE_VERSION);
    expect(BACKUP_HEADER_BYTES).toBe(6 + 1 + 12 + 16);
    expect(payload.byteLength).toBe(BACKUP_HEADER_BYTES + PLAINTEXT.byteLength);
    expect(looksLikeBackupEnvelope(payload)).toBe(true);
  });

  it('uses a fresh 96-bit IV per backup, so identical data encrypts differently', () => {
    const first = encryptBackup(PLAINTEXT, KEY, metadata());
    const second = encryptBackup(PLAINTEXT, KEY, metadata());
    const ivOf = (payload: Buffer) => payload.subarray(7, 19);
    expect(ivOf(first.payload).equals(ivOf(second.payload))).toBe(false);
    expect(first.payload.equals(second.payload)).toBe(false);
    // Both still decrypt to the same plaintext.
    expect(decryptBackup(first.payload, KEY, first.metadata).plaintext.equals(PLAINTEXT)).toBe(true);
    expect(decryptBackup(second.payload, KEY, second.metadata).plaintext.equals(PLAINTEXT)).toBe(true);
  });

  it('rejects the wrong key', () => {
    const encrypted = encryptBackup(PLAINTEXT, KEY, metadata());
    const wrong = fixedKeyForTests('not-the-key');
    expect(() => decryptBackup(encrypted.payload, wrong, encrypted.metadata)).toThrowError(
      /could not be decrypted/i,
    );
  });

  it('rejects a corrupted file', () => {
    const encrypted = encryptBackup(PLAINTEXT, KEY, metadata());
    const corrupted = Buffer.from(encrypted.payload);
    corrupted[BACKUP_HEADER_BYTES + 3] ^= 0xff;
    expect(() => decryptBackup(corrupted, KEY, encrypted.metadata)).toThrowError(
      /could not be decrypted/i,
    );
  });

  it('rejects a tampered authentication tag', () => {
    const encrypted = encryptBackup(PLAINTEXT, KEY, metadata());
    const tampered = Buffer.from(encrypted.payload);
    tampered[19] ^= 0x01;
    expect(() => decryptBackup(tampered, KEY, encrypted.metadata)).toThrowError(
      /could not be decrypted/i,
    );
  });

  it('rejects a truncated file and a file that is not a DKS backup', () => {
    const encrypted = encryptBackup(PLAINTEXT, KEY, metadata());
    expect(() => decryptBackup(encrypted.payload.subarray(0, 10), KEY, encrypted.metadata))
      .toThrowError(/truncated/i);
    const notABackup = Buffer.concat([
      Buffer.from('this file is not a DKS backup, it is just filler text'),
    ]);
    expect(() => decryptBackup(notABackup, KEY, encrypted.metadata)).toThrowError(/not a DKS backup/i);
  });

  it('rejects an unknown envelope version', () => {
    const encrypted = encryptBackup(PLAINTEXT, KEY, metadata());
    const bumped = Buffer.from(encrypted.payload);
    bumped[6] = 9;
    expect(() => decryptBackup(bumped, KEY, encrypted.metadata)).toThrowError(/version 9/i);
  });

  it('binds the metadata to the ciphertext, so a swapped checksum fails', () => {
    const encrypted = encryptBackup(PLAINTEXT, KEY, metadata());
    const swapped = { ...encrypted.metadata, plaintextSha256: sha256Hex(Buffer.from('other data')) };
    expect(() => decryptBackup(encrypted.payload, KEY, swapped)).toThrowError(
      /could not be decrypted/i,
    );
  });

  it('refuses malformed metadata before touching the ciphertext', () => {
    const encrypted = encryptBackup(PLAINTEXT, KEY, metadata());
    const bad = { ...encrypted.metadata, plaintextSha256: 'nope' };
    expect(isBackupMetadata(bad)).toBe(false);
    expect(() => decryptBackup(encrypted.payload, KEY, bad)).toThrowError(/metadata/i);
  });
});

describe('backup key handling', () => {
  it('generates 32 distinct bytes and shows them once as base64', () => {
    const first = generateBackupKey();
    const second = generateBackupKey();
    expect(first.byteLength).toBe(BACKUP_KEY_BYTES);
    expect(first.equals(second)).toBe(false);

    const shown = formatRecoveryKey(first);
    expect(parseRecoveryKey(shown).equals(first)).toBe(true);
    expect(parseRecoveryKey(`  ${shown}\n`).equals(first)).toBe(true);
  });

  it('rejects a recovery key that is not 32 bytes', () => {
    expect(() => parseRecoveryKey('')).toThrowError(/Enter the recovery key/i);
    expect(() => parseRecoveryKey(Buffer.alloc(16).toString('base64'))).toThrowError(/wrong length/i);
  });

  it('verifies a typed key against the stored hash in constant time', () => {
    const key = generateBackupKey();
    const stored = keyVerificationHash(key);
    expect(matchesStoredKey(key, stored)).toBe(true);
    expect(matchesStoredKey(generateBackupKey(), stored)).toBe(false);
    expect(matchesStoredKey(key, 'garbage')).toBe(false);
  });

  it('wraps the key with safeStorage and refuses to fall back to plaintext', () => {
    const key = generateBackupKey();
    const available: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(`wrapped:${text}`, 'utf8'),
      decryptString: (buffer) => buffer.toString('utf8').replace(/^wrapped:/, ''),
    };
    const wrapped = wrapKeyForStorage(key, available);
    expect(wrapped.equals(key)).toBe(false);
    expect(unwrapStoredKey(wrapped, available).equals(key)).toBe(true);

    const unavailable: SafeStorageLike = {
      isEncryptionAvailable: () => false,
      encryptString: (text) => Buffer.from(text),
      decryptString: (buffer) => buffer.toString('utf8'),
    };
    expect(() => wrapKeyForStorage(key, unavailable)).toThrowError(/key store/i);
    expect(() => wrapKeyForStorage(key, null)).toThrowError(/key store/i);
    expect(() => unwrapStoredKey(wrapped, unavailable)).toThrowError(/key store/i);
  });
});
