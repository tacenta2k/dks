// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  BackupApiClient,
  decodeRecordCounts as clientDecode,
  encodeRecordCounts as clientEncode,
} from '../electron/main/backup-client';
import {
  decodeRecordCounts as workerDecode,
  encodeRecordCounts as workerEncode,
  isBackupEnvelope,
} from '../cloudflare-backup/src/routes';
import { encryptBackup } from '../electron/main/backup-crypto';

/**
 * The desktop client and the Worker are built separately and talk over HTTP
 * headers and R2 custom metadata — both plain strings. This suite pins the
 * shared wire format from BOTH sides so a change in one cannot silently
 * orphan a field in the other.
 *
 * Found by review: the client used to send `x-dks-record-counts` as JSON while
 * the Worker decodes `k=v;k=v` (the only shape that survives R2 metadata
 * sanitising), so every uploaded backup stored an empty record count and the
 * history showed "—" instead of the number of records.
 */

const COUNTS = {
  entries: 1200,
  entriesActive: 1199,
  entriesDeleted: 1,
  columns: 7,
  settings: 12,
  auditLog: 503,
};

const WORKER_URL = 'https://dks-backup.example.workers.dev';
const KEY_ID = 'a'.repeat(24);

function makeClient(fetchImpl: typeof fetch): BackupApiClient {
  return new BackupApiClient({
    workerUrl: WORKER_URL,
    accessToken: 'test-access-token',
    fetchImpl,
    appVersion: '0.1.11',
  });
}

function makeEnvelope(): Buffer {
  return encryptBackup(Buffer.from('synthetic snapshot bytes', 'utf8'), Buffer.alloc(32, 7), {
    plaintextSha256: '',
    fingerprint: 'f'.repeat(64),
    appVersion: '0.1.11',
    schemaVersion: 4,
    recordCounts: COUNTS,
    createdAt: '2026-10-31T08:00:00.000Z',
    keyId: KEY_ID,
    source: 'local-cache',
  }).payload;
}

describe('record-count wire format', () => {
  it('uses the same k=v;k=v shape on both sides', () => {
    expect(clientEncode(COUNTS)).toBe('entries=1200;entriesActive=1199;entriesDeleted=1;columns=7;settings=12;auditLog=503');
    expect(clientEncode(COUNTS)).toBe(workerEncode(COUNTS));
    expect(clientEncode({})).toBe('');
    expect(clientEncode(null)).toBe('');
    expect(clientEncode({ entries: Number.NaN, columns: 3 })).toBe('columns=3');
  });

  it('cross-decodes in both directions', () => {
    expect(workerDecode(clientEncode(COUNTS))).toEqual(COUNTS);
    expect(clientDecode(workerEncode(COUNTS))).toEqual(COUNTS);
    expect(clientDecode(null)).toEqual({});
    expect(clientDecode('')).toEqual({});
    expect(clientDecode('nonsense')).toEqual({});
  });

  it('stays HTTP-header and R2-metadata safe', () => {
    const header = clientEncode(COUNTS);
    expect(header).not.toMatch(/[{}":,\s]/);
    // Survives a real Headers round trip untouched.
    const headers = new Headers({ 'x-dks-record-counts': header });
    expect(headers.get('x-dks-record-counts')).toBe(header);
    expect(workerDecode(headers.get('x-dks-record-counts'))).toEqual(COUNTS);
  });
});

describe('the real client speaks the Worker format', () => {
  it('sends record counts the Worker can decode on upload', async () => {
    let captured: Headers | null = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers as Record<string, string>);
      return Response.json(
        {
          id: 'backups/2026/10/2026-10-31/080000-abcdef012345.sqlite.enc',
          key: 'backups/2026/10/2026-10-31/080000-abcdef012345.sqlite.enc',
          size: 24,
          ciphertextSha256: 'a'.repeat(64),
        },
        { status: 201 },
      );
    }) as unknown as typeof fetch;

    const payload = makeEnvelope();
    const client = makeClient(fetchImpl);
    const uploaded = await client.upload(payload, {
      plaintextSha256: 'b'.repeat(64),
      fingerprint: 'f'.repeat(64),
      appVersion: '0.1.11',
      schemaVersion: 4,
      recordCounts: COUNTS,
      createdAt: '2026-10-31T08:00:00.000Z',
      keyId: KEY_ID,
      source: 'local-cache',
    });

    expect(uploaded.size).toBe(24);
    expect(captured).not.toBeNull();
    const capturedHeaders = captured as unknown as Headers;
    expect(workerDecode(capturedHeaders.get('x-dks-record-counts'))).toEqual(COUNTS);
    expect(capturedHeaders.get('x-dks-key-id')).toBe(KEY_ID);
    expect(capturedHeaders.get('x-dks-source')).toBe('local-cache');
    // The client declares the ciphertext checksum; the Worker stores it verbatim.
    expect(capturedHeaders.get('x-dks-ciphertext-sha256')).toMatch(/^[0-9a-f]{64}$/);
    // The payload the Worker would validate is still a real envelope.
    expect(isBackupEnvelope(new Uint8Array(payload))).toBe(true);
  });

  it('reads record counts back from the headers the Worker emits', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 200,
        headers: {
          'x-dks-plaintext-sha256': 'b'.repeat(64),
          'x-dks-ciphertext-sha256': 'a'.repeat(64),
          'x-dks-fingerprint': 'f'.repeat(64),
          'x-dks-schema-version': '4',
          'x-dks-record-counts': workerEncode(COUNTS),
          'x-dks-created-at': '2026-10-31T08:00:00.000Z',
          'x-dks-key-id': KEY_ID,
          'x-dks-source': 'local-cache',
          'x-dks-app-version': '0.1.11',
          'x-dks-size': '1234',
        },
      }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.listMetadataFor(
      'backups/2026/10/2026-10-31/080000-abcdef012345.sqlite.enc',
    );

    expect(result.size).toBe(1234);
    expect(result.metadata?.recordCounts).toEqual(COUNTS);
    expect(result.metadata?.schemaVersion).toBe(4);
    expect(result.metadata?.keyId).toBe(KEY_ID);
    expect(result.metadata?.source).toBe('local-cache');
    expect(result.ciphertextSha256).toBe('a'.repeat(64));
  });
});
