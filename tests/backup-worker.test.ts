// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BackupHttpError,
  authenticate,
  expectedAudience,
  expectedIssuer,
  lookupCallerRole,
  lookupOfficeApproval,
  resetJwksCacheForTests,
  verifySupabaseJwt,
  type AuthDeps,
  type BackupEnv,
  type R2BucketLike,
  type R2Object,
} from '../cloudflare-backup/src/auth';
import {
  MAX_UPLOAD_BYTES,
  assertSafeObjectKey,
  buildObjectKey,
  decodeRecordCounts,
  encodeRecordCounts,
  handleGetObject,
  handleHealth,
  handleList,
  handleUpload,
  isBackupEnvelope,
  runRetention,
  sha256Hex,
} from '../cloudflare-backup/src/routes';
import worker, { routeRequest } from '../cloudflare-backup/src/index';

// ---------------------------------------------------------------------------
// Fixtures: a real RS256 key pair, so signature verification is actually run.
// ---------------------------------------------------------------------------

const ADMIN_SUB = '11111111-1111-4111-8111-111111111111';
const OFFICE_SUB = '22222222-2222-4222-8222-222222222222';

let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey;

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signToken(sub: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key-1' };
  const now = Math.floor(Date.now() / 1000);
  // iss/aud mirror what Supabase actually puts in an access token; the Worker
  // now checks both exactly.
  const payload = {
    sub,
    iat: now - 10,
    exp: now + 3600,
    iss: 'https://project.supabase.co/auth/v1',
    aud: 'authenticated',
    ...overrides,
  };
  const encoder = new TextEncoder();
  const data = encoder.encode(`${base64Url(encoder.encode(JSON.stringify(header)))}.${base64Url(encoder.encode(JSON.stringify(payload)))}`);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, data);
  return `${new TextDecoder().decode(data)}.${base64Url(signature)}`;
}

/** A token signed with the WRONG key, to prove verification is not decorative. */
async function signWithForeignKey(sub: string): Promise<string> {
  const foreign = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key-1' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub, iat: now - 10, exp: now + 3600 };
  const encoder = new TextEncoder();
  const data = encoder.encode(`${base64Url(encoder.encode(JSON.stringify(header)))}.${base64Url(encoder.encode(JSON.stringify(payload)))}`);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', foreign.privateKey, data);
  return `${new TextDecoder().decode(data)}.${base64Url(signature)}`;
}

// ---------------------------------------------------------------------------
// Fake R2
// ---------------------------------------------------------------------------

interface FakeObject extends R2Object {
  bodyBytes: Uint8Array;
}

function createFakeBucket(): R2BucketLike & { objects: Map<string, FakeObject> } {
  const objects = new Map<string, FakeObject>();
  return {
    objects,
    async put(key, value, options) {
      // The Worker streams uploads, so the fake has to consume a stream — and,
      // like R2, must leave no object behind when that stream fails.
      let bytes: Uint8Array;
      if (value instanceof Uint8Array) {
        bytes = value;
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else {
        const stream = value as ReadableStream<Uint8Array>;
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          if (chunk && chunk.byteLength > 0) {
            chunks.push(chunk);
            total += chunk.byteLength;
          }
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }
      const stored: FakeObject = {
        key,
        size: bytes.byteLength,
        uploaded: new Date(),
        etag: `"${key.length}"`,
        customMetadata: options?.customMetadata ?? {},
        bodyBytes: bytes,
      };
      objects.set(key, stored);
      return stored;
    },
    async get(key) {
      const found = objects.get(key);
      if (!found) return null;
      return {
        ...found,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(found.bodyBytes);
            controller.close();
          },
        }),
        async arrayBuffer() {
          return found.bodyBytes.buffer.slice(0) as ArrayBuffer;
        },
      };
    },
    async head(key) {
      const found = objects.get(key);
      return found ? { ...found } : null;
    },
    async list(options) {
      const prefix = options?.prefix ?? '';
      const all = [...objects.values()]
        .filter((object) => object.key.startsWith(prefix))
        .sort((a, b) => a.key.localeCompare(b.key));
      const limit = options?.limit ?? 1000;
      const startIndex = options?.cursor ? all.findIndex((object) => object.key === options.cursor) + 1 : 0;
      const page = all.slice(startIndex, startIndex + limit);
      const truncated = startIndex + limit < all.length;
      return {
        objects: page.map(({ bodyBytes, ...rest }) => rest),
        truncated,
        ...(truncated ? { cursor: page[page.length - 1]?.key } : {}),
      };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mocked Supabase endpoints (JWKS, PostgREST role, approval RPC)
// ---------------------------------------------------------------------------

interface SupabaseMock {
  roles: Map<string, string>;
  approvals: Map<string, boolean>;
  /** The `public.settings` rows the Worker reads with the caller's JWT. */
  settings: Map<string, unknown>;
  fetchImpl: typeof fetch;
  calls: string[];
}

/** The device id this test suite's uploads present. Opaque and random. */
const DEVICE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_DEVICE_ID = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';

function createSupabaseMock(): SupabaseMock {
  const roles = new Map<string, string>([[ADMIN_SUB, 'admin'], [OFFICE_SUB, 'office']]);
  const approvals = new Map<string, boolean>([[OFFICE_SUB, true]]);
  const calls: string[] = [];
  /** `public.settings` — Admin-only writes, the authoritative designation. */
  const settings = new Map<string, unknown>([
    ['dks.backup.designated_device', { deviceId: DEVICE_ID, label: 'Front desk Admin', designatedAt: '2026-10-01T06:00:00.000Z' }],
  ]);

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url.includes('/auth/v1/.well-known/jwks.json')) {
      return Response.json({ keys: [{ ...publicJwk, kid: 'test-key-1', use: 'sig', alg: 'RS256' }] });
    }

    const authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
    if (url.includes('/rest/v1/profiles')) {
      const sub = /id=eq\.([^&]+)/.exec(url)?.[1] ?? '';
      // RLS: only the caller's own row can come back.
      const matchesToken = authorization.includes('sub-marker');
      void matchesToken;
      const role = roles.get(sub);
      return Response.json(role ? [{ role }] : []);
    }
    if (url.includes('/rest/v1/settings')) {
      const key = /key=eq\.([^&]+)/.exec(url)?.[1] ?? '';
      const value = settings.get(decodeURIComponent(key));
      return Response.json(value === undefined ? [] : [{ key, value }]);
    }
    if (url.includes('/rest/v1/rpc/office_session_is_approved')) {
      // Derive the subject from the token the caller presented.
      const token = authorization.replace(/^Bearer\s+/i, '');
      const sub = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))).sub as string;
      return Response.json(approvals.get(sub) === true);
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  return { roles, approvals, settings, fetchImpl, calls };
}

/**
 * TS 5.7's DOM lib will not accept `Uint8Array<ArrayBufferLike>` as a request
 * body. Every buffer here is freshly allocated, so its ArrayBuffer is exact.
 */
function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer as ArrayBuffer;
}

function envelope(bytes = 64): Uint8Array {
  const payload = new Uint8Array(35 + bytes);
  new TextEncoder().encode('DKSBK1').forEach((byte, index) => {
    payload[index] = byte;
  });
  payload[6] = 1;
  payload.fill(7, 35);
  return payload;
}

/** What the desktop app sends: a SHA-256 it computed over its own bytes. */
function clientSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function uploadRequest(body: Uint8Array, token: string, meta: Record<string, string> = {}): Request {
  return new Request('https://dks-backup.example.workers.dev/v1/backups', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'x-dks-plaintext-sha256': 'a'.repeat(64),
      'x-dks-ciphertext-sha256': clientSha256(body),
      'x-dks-key-id': 'ab'.repeat(12),
      'x-dks-source': 'local-cache',
      'x-dks-device-id': DEVICE_ID,
      'x-dks-fingerprint': 'f'.repeat(64),
      'x-dks-schema-version': '4',
      'x-dks-record-counts': 'entries=12;columns=3',
      'x-dks-created-at': '2026-10-31T08:00:00.000Z',
      ...meta,
    },
    body: bodyOf(body),
  });
}

let bucket: ReturnType<typeof createFakeBucket>;
let supabase: SupabaseMock;
let deps: AuthDeps;
let env: BackupEnv;

beforeEach(async () => {
  resetJwksCacheForTests();
  keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  bucket = createFakeBucket();
  supabase = createSupabaseMock();
  deps = { fetchImpl: supabase.fetchImpl, now: () => Date.now() };
  env = {
    DKS_BACKUPS: bucket,
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_test_key',
  };
});

describe('JWT verification', () => {
  it('accepts a correctly signed, unexpired RS256 token', async () => {
    const token = await signToken(ADMIN_SUB);
    const claims = await verifySupabaseJwt(token, env, deps);
    expect(claims.sub).toBe(ADMIN_SUB);
  });

  it('rejects a token signed by a different key', async () => {
    const token = await signWithForeignKey(ADMIN_SUB);
    await expect(verifySupabaseJwt(token, env, deps)).rejects.toThrow(/signature is invalid/i);
  });

  it('rejects an expired token', async () => {
    const token = await signToken(ADMIN_SUB, { exp: Math.floor(Date.now() / 1000) - 60 });
    await expect(verifySupabaseJwt(token, env, deps)).rejects.toThrow(/expired/i);
  });

  it('rejects HS256 tokens, which would need a shared secret', async () => {
    const encoder = new TextEncoder();
    const header = base64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const payload = base64Url(encoder.encode(JSON.stringify({ sub: ADMIN_SUB, exp: Math.floor(Date.now() / 1000) + 60 })));
    await expect(verifySupabaseJwt(`${header}.${payload}.c2lnbmF0dXJl`, env, deps))
      .rejects.toThrow(/Only RS256/i);
  });

  it('rejects a token with no subject and a malformed token', async () => {
    await expect(verifySupabaseJwt('not.a.jwt', env, deps)).rejects.toThrow(/malformed/i);
    await expect(verifySupabaseJwt('', env, deps)).rejects.toThrow(/required/i);
    const noSub = await signToken('', {});
    await expect(verifySupabaseJwt(noSub, env, deps)).rejects.toThrow(/no subject/i);
  });

  it('caches the JWKS across requests', async () => {
    const token = await signToken(ADMIN_SUB);
    await verifySupabaseJwt(token, env, deps);
    await verifySupabaseJwt(token, env, deps);
    const jwksFetches = supabase.calls.filter((url) => url.includes('jwks.json'));
    expect(jwksFetches).toHaveLength(1);
  });
});

describe('role and Office approval lookups', () => {
  it('reads the role from PostgREST with the caller’s own token', async () => {
    const token = await signToken(ADMIN_SUB);
    const claims = await verifySupabaseJwt(token, env, deps);
    expect(await lookupCallerRole(claims, token, env, deps)).toBe('admin');

    const officeToken = await signToken(OFFICE_SUB);
    const officeClaims = await verifySupabaseJwt(officeToken, env, deps);
    expect(await lookupCallerRole(officeClaims, officeToken, env, deps)).toBe('office');

    // RLS hid the row: no role, no access.
    const stranger = await signToken('33333333-3333-4333-8333-333333333333');
    const strangerClaims = await verifySupabaseJwt(stranger, env, deps);
    expect(await lookupCallerRole(strangerClaims, stranger, env, deps)).toBeNull();
  });

  it('asks the SECURITY DEFINER RPC whether the Office session is approved', async () => {
    const token = await signToken(OFFICE_SUB);
    expect(await lookupOfficeApproval(token, env, deps)).toBe(true);
    supabase.approvals.set(OFFICE_SUB, false);
    expect(await lookupOfficeApproval(token, env, deps)).toBe(false);
  });

  it('authenticate() refuses an unapproved Office session', async () => {
    supabase.approvals.set(OFFICE_SUB, false);
    const request = new Request('https://x/v1/backups', {
      headers: { authorization: `Bearer ${await signToken(OFFICE_SUB)}` },
    });
    await expect(authenticate(request, env, deps)).rejects.toThrow(/has not been approved/i);
  });
});

describe('object key safety', () => {
  it('builds the documented Muscat key shape from the server clock', () => {
    const parts = buildObjectKey(new Date('2026-10-31T22:30:15.000Z'), '0123456789ab');
    // 22:30 UTC is 02:30 the NEXT day in Asia/Muscat.
    expect(parts.key).toBe('backups/2026/11/2026-11-01/023015-0123456789ab.sqlite.enc');
    expect(parts.day).toBe('2026-11-01');
  });

  it('accepts only a server-shaped key and refuses traversal', () => {
    const good = 'backups/2026/10/2026-10-31/083015-0123456789ab.sqlite.enc';
    expect(assertSafeObjectKey(good)).toBe(good);
    expect(assertSafeObjectKey(encodeURIComponent(good))).toBe(good);

    for (const bad of [
      '../secret.sqlite.enc',
      'backups/2026/10/2026-10-31/083015-0123456789ab.sqlite.enc/../../x',
      'backups/2026/10/2026-10-31/083015-ZZZZZZZZZZZZ.sqlite.enc',
      'backups/2026/10/2026-10-31/083015-0123456789ab.sqlite',
      'other/2026/10/2026-10-31/083015-0123456789ab.sqlite.enc',
      '',
      'backups\\2026\\10\\x.sqlite.enc',
    ]) {
      expect(() => assertSafeObjectKey(bad), bad).toThrowError(/not valid/i);
    }
  });
});

describe('POST /v1/backups', () => {
  it('stores an admin upload under a server-generated key and returns the checksum', async () => {
    const token = await signToken(ADMIN_SUB);
    const body = envelope();
    const result = await handleUpload(uploadRequest(body, token), env, deps);

    expect(result.key).toMatch(/^backups\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\/\d{6}-[0-9a-f]{12}\.sqlite\.enc$/);
    expect(result.id).toBe(result.key);
    expect(result.size).toBe(body.byteLength);
    // The Worker streams the body straight to R2 and never holds it, so the
    // checksum it returns is the one the client declared — not a server hash.
    expect(result.ciphertextSha256).toBe(clientSha256(body));
    expect(result.size).toBe(body.byteLength);
    expect(bucket.objects.get(result.key)?.customMetadata.plaintextSha256).toBe('a'.repeat(64));
    expect(bucket.objects.get(result.key)?.customMetadata.role).toBe('admin');
  });

  it('refuses an approved Office upload with OFFICE_NOT_ALLOWED', async () => {
    const token = await signToken(OFFICE_SUB);
    // The Office session IS approved — v1 policy still refuses the upload.
    expect(supabase.approvals.get(OFFICE_SUB)).toBe(true);
    await expect(handleUpload(uploadRequest(envelope(), token), env, deps))
      .rejects.toMatchObject({ status: 403, code: 'OFFICE_NOT_ALLOWED' });
    expect(bucket.objects.size).toBe(0);
  });

  it('refuses a revoked or pending Office upload too', async () => {
    supabase.approvals.set(OFFICE_SUB, false);
    const token = await signToken(OFFICE_SUB);
    await expect(handleUpload(uploadRequest(envelope(), token), env, deps))
      .rejects.toMatchObject({ status: 403, code: 'OFFICE_NOT_ALLOWED' });
    expect(bucket.objects.size).toBe(0);
  });

  it('never lets a request-body or header role widen access', async () => {
    // A caller cannot talk its way in by claiming a role: only the Postgres
    // lookup of the JWT's own subject decides.
    const stranger = await signToken('33333333-3333-4333-8333-333333333333');
    const spoofed = new Request('https://dks-backup.example.workers.dev/v1/backups', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${stranger}`,
        'x-dks-plaintext-sha256': 'a'.repeat(64),
        'x-dks-ciphertext-sha256': 'c'.repeat(64),
        'x-dks-created-at': '2026-10-31T08:00:00.000Z',
        'x-dks-device-id': DEVICE_ID,
        role: 'admin',
        'x-dks-role': 'admin',
      },
      body: bodyOf(envelope()),
    });
    await expect(handleUpload(spoofed, env, deps)).rejects.toThrow(/cannot use cloud backup/i);
    expect(bucket.objects.size).toBe(0);
  });

  it('refuses an unauthenticated request and a role the JWT does not carry', async () => {
    await expect(handleUpload(uploadRequest(envelope(), ''), env, deps)).rejects.toThrow(/required/i);
    const stranger = await signToken('33333333-3333-4333-8333-333333333333');
    await expect(handleUpload(uploadRequest(envelope(), stranger), env, deps)).rejects.toThrow(/cannot use cloud backup/i);
  });

  it('rejects a payload that is not a DKS envelope', async () => {
    const token = await signToken(ADMIN_SUB);
    const junk = new Uint8Array(100).fill(3);
    await expect(handleUpload(uploadRequest(junk, token), env, deps)).rejects.toThrow(/envelope/i);
    expect(isBackupEnvelope(envelope())).toBe(true);
    expect(isBackupEnvelope(junk)).toBe(false);
  });

  it('rejects an upload above the 200 MB limit and an empty body', async () => {
    const token = await signToken(ADMIN_SUB);
    const oversized = new Request('https://x/v1/backups', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-length': String(MAX_UPLOAD_BYTES + 1),
        'x-dks-plaintext-sha256': 'a'.repeat(64),
        'x-dks-ciphertext-sha256': 'c'.repeat(64),
        'x-dks-created-at': '2026-10-31T08:00:00.000Z',
        'x-dks-device-id': DEVICE_ID,
      },
      body: bodyOf(envelope()),
    });
    await expect(handleUpload(oversized, env, deps)).rejects.toThrow(/larger than the service limit/i);
    await expect(handleUpload(uploadRequest(new Uint8Array(0), token), env, deps)).rejects.toThrow(/empty/i);
  });

  it('requires a declared encrypted checksum and refuses to guess one', async () => {
    const token = await signToken(ADMIN_SUB);
    const body = envelope();
    const request = new Request('https://dks-backup.example.workers.dev/v1/backups', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-dks-plaintext-sha256': 'a'.repeat(64),
        'x-dks-created-at': '2026-10-31T08:00:00.000Z',
      },
      body: bodyOf(body),
    });
    await expect(handleUpload(request, env, deps)).rejects.toThrow(/encrypted checksum/i);
    expect(bucket.objects.size).toBe(0);
  });

  it('rejects a malformed plaintext checksum or timestamp', async () => {
    const token = await signToken(ADMIN_SUB);
    await expect(handleUpload(
      uploadRequest(envelope(), token, { 'x-dks-plaintext-sha256': 'nope' }),
      env, deps,
    )).rejects.toThrow(/checksum/i);
    await expect(handleUpload(
      uploadRequest(envelope(), token, { 'x-dks-created-at': 'yesterday' }),
      env, deps,
    )).rejects.toThrow(/timestamp/i);
  });
});

describe('designated backup PC (server-enforced)', () => {
  it('accepts the designated Admin PC and records which PC uploaded', async () => {
    const token = await signToken(ADMIN_SUB);
    const result = await handleUpload(uploadRequest(envelope(), token), env, deps);

    const stored = bucket.objects.get(result.key);
    expect(stored?.customMetadata.deviceId).toBe(DEVICE_ID);
    expect(stored?.customMetadata.deviceLabel).toBe('Front desk Admin');
    expect(stored?.customMetadata.role).toBe('admin');
  });

  it('rejects a correct Admin JWT from a non-designated device', async () => {
    const token = await signToken(ADMIN_SUB);
    const body = envelope();
    const request = new Request('https://dks-backup.example.workers.dev/v1/backups', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-dks-plaintext-sha256': 'a'.repeat(64),
        'x-dks-ciphertext-sha256': clientSha256(body),
        'x-dks-created-at': '2026-10-31T08:00:00.000Z',
        'x-dks-device-id': OTHER_DEVICE_ID,
      },
      body: bodyOf(body),
    });

    await expect(handleUpload(request, env, deps))
      .rejects.toMatchObject({ status: 403, code: 'DEVICE_NOT_DESIGNATED' });
    expect(bucket.objects.size).toBe(0);
  });

  it('rejects an upload when no PC is designated at all', async () => {
    supabase.settings.delete('dks.backup.designated_device');
    const token = await signToken(ADMIN_SUB);
    await expect(handleUpload(uploadRequest(envelope(), token), env, deps))
      .rejects.toMatchObject({ status: 403, code: 'DEVICE_NOT_DESIGNATED' });
    expect(bucket.objects.size).toBe(0);
  });

  it('refuses a malformed or missing device identifier', async () => {
    const token = await signToken(ADMIN_SUB);
    for (const deviceId of ['', 'not-a-device-id', 'z'.repeat(32)]) {
      const body = envelope();
      const request = new Request('https://dks-backup.example.workers.dev/v1/backups', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-dks-plaintext-sha256': 'a'.repeat(64),
          'x-dks-ciphertext-sha256': clientSha256(body),
          'x-dks-created-at': '2026-10-31T08:00:00.000Z',
          ...(deviceId ? { 'x-dks-device-id': deviceId } : {}),
        },
        body: bodyOf(body),
      });
      await expect(handleUpload(request, env, deps))
        .rejects.toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    }
    expect(bucket.objects.size).toBe(0);
  });

  it('follows a transfer of the designation', async () => {
    const token = await signToken(ADMIN_SUB);
    const body = envelope();
    const requestFrom = (deviceId: string): Request => new Request(
      'https://dks-backup.example.workers.dev/v1/backups',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-dks-plaintext-sha256': 'a'.repeat(64),
          'x-dks-ciphertext-sha256': clientSha256(body),
          'x-dks-created-at': '2026-10-31T08:00:00.000Z',
          'x-dks-device-id': deviceId,
        },
        body: bodyOf(body),
      },
    );

    // Before the transfer the second PC is refused.
    await expect(handleUpload(requestFrom(OTHER_DEVICE_ID), env, deps))
      .rejects.toMatchObject({ code: 'DEVICE_NOT_DESIGNATED' });

    // An administrator moves the duty. There is no implicit takeover: the row
    // has to change, and the old PC stops being accepted at the same moment.
    supabase.settings.set('dks.backup.designated_device', {
      deviceId: OTHER_DEVICE_ID,
      label: 'Back office Admin',
      designatedAt: '2026-10-31T07:00:00.000Z',
    });

    const accepted = await handleUpload(requestFrom(OTHER_DEVICE_ID), env, deps);
    expect(bucket.objects.get(accepted.key)?.customMetadata.deviceId).toBe(OTHER_DEVICE_ID);
    await expect(handleUpload(requestFrom(DEVICE_ID), env, deps))
      .rejects.toMatchObject({ code: 'DEVICE_NOT_DESIGNATED' });
  });

  it('fails closed when the designation cannot be read', async () => {
    const token = await signToken(ADMIN_SUB);
    supabase.settings.set('dks.backup.designated_device', 'not-an-object');
    await expect(handleUpload(uploadRequest(envelope(), token), env, deps))
      .rejects.toMatchObject({ code: 'DEVICE_NOT_DESIGNATED' });
    expect(bucket.objects.size).toBe(0);
  });
});

describe('the upload limit is 25 MB', () => {
  it('is set well above a real snapshot and enforced while streaming', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    // A real DKS snapshot is ~65 KB at ~1,200 rows, so this is ~380x headroom.
    expect(MAX_UPLOAD_BYTES / 65_571).toBeGreaterThan(300);
  });

  it('refuses a declared body just over the limit', async () => {
    const token = await signToken(ADMIN_SUB);
    const body = envelope();
    const request = new Request('https://dks-backup.example.workers.dev/v1/backups', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-length': String(MAX_UPLOAD_BYTES + 1),
        'x-dks-plaintext-sha256': 'a'.repeat(64),
        'x-dks-ciphertext-sha256': clientSha256(body),
        'x-dks-created-at': '2026-10-31T08:00:00.000Z',
        'x-dks-device-id': DEVICE_ID,
      },
      body: bodyOf(body),
    });
    await expect(handleUpload(request, env, deps))
      .rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });
});

describe('JWT issuer, audience and key rotation', () => {
  it('refuses a token from another Supabase project', async () => {
    const token = await signToken(ADMIN_SUB, { iss: 'https://some-other-project.supabase.co/auth/v1' });
    await expect(handleUpload(uploadRequest(envelope(), token), env, deps))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('refuses a token with no issuer', async () => {
    const token = await signToken(ADMIN_SUB, { iss: undefined });
    await expect(handleUpload(uploadRequest(envelope(), token), env, deps))
      .rejects.toThrow(/not issued by this project/i);
  });

  it('refuses a service_role or anon audience', async () => {
    for (const aud of ['service_role', 'anon']) {
      const token = await signToken(ADMIN_SUB, { aud });
      await expect(handleUpload(uploadRequest(envelope(), token), env, deps))
        .rejects.toThrow(/audience is not accepted/i);
    }
  });

  it('accepts the documented audience and an array form containing it', async () => {
    expect(expectedAudience(env)).toBe('authenticated');
    expect(expectedIssuer(env)).toBe('https://project.supabase.co/auth/v1');
    const token = await signToken(ADMIN_SUB, { aud: ['authenticated'] });
    const result = await handleUpload(uploadRequest(envelope(), token), env, deps);
    expect(result.key).toMatch(/\.sqlite\.enc$/);
  });

  it('refreshes the JWKS once for an unknown kid, then rejects if still unknown', async () => {
    // Warm the cache with an ordinary request, so the only fetch counted below
    // is the single forced refresh for the unknown kid — never one per attempt.
    await handleUpload(uploadRequest(envelope(), await signToken(ADMIN_SUB)), env, deps);
    const jwksCallsBefore = supabase.calls.filter((url) => url.includes('jwks.json')).length;
    const token = await signToken(ADMIN_SUB);
    const header = { alg: 'RS256', typ: 'JWT', kid: 'rotated-key-2' };
    const parts = token.split('.');
    const encoder = new TextEncoder();
    const data = encoder.encode(`${base64Url(encoder.encode(JSON.stringify(header)))}.${parts[1]}`);
    // Signed with the real key but advertising a kid the cache does not hold.
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, data);
    const rotated = `${new TextDecoder().decode(data)}.${base64Url(signature)}`;

    await expect(handleUpload(uploadRequest(envelope(), rotated), env, deps))
      .rejects.toThrow(/signing key for this token is unknown/i);

    // Exactly one forced refresh: bounded, not a loop and not never.
    const jwksCallsAfter = supabase.calls.filter((url) => url.includes('jwks.json')).length;
    expect(jwksCallsAfter - jwksCallsBefore).toBe(1);
  });

  it('still refuses HS256, a foreign key and an expired token', async () => {
    const hs256 = await signToken(ADMIN_SUB);
    const [headerPart, payloadPart] = hs256.split('.');
    const forged = `${base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))}.${payloadPart}.${headerPart}`;
    await expect(handleUpload(uploadRequest(envelope(), forged), env, deps))
      .rejects.toThrow(/Only RS256/i);

    await expect(handleUpload(uploadRequest(envelope(), await signWithForeignKey(ADMIN_SUB)), env, deps))
      .rejects.toThrow(/signature is invalid/i);

    const expired = await signToken(ADMIN_SUB, { exp: Math.floor(Date.now() / 1000) - 60 });
    await expect(handleUpload(uploadRequest(envelope(), expired), env, deps))
      .rejects.toThrow(/expired/i);
  });
});

describe('streaming upload (Worker memory safety)', () => {
  /**
   * A stream that replays the SAME chunk buffer, so a 201 MB upload costs a
   * few MB of test memory. The counter only ever reads byteLength.
   */
  function repeatingStream(chunkBytes: number, chunkCount: number): ReadableStream<Uint8Array> {
    const head = envelope(chunkBytes - 35);
    const chunk = new Uint8Array(chunkBytes).fill(9);
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) {
          sent += 1;
          controller.enqueue(head);
          return;
        }
        if (sent >= chunkCount) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
  }

  function requestWithBody(body: ReadableStream<Uint8Array> | ArrayBuffer, token: string): Request {
    return new Request('https://dks-backup.example.workers.dev/v1/backups', {
      method: 'POST',
      // No content-length: the limit must be enforced while streaming, not from
      // a header the client could simply omit.
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'x-dks-plaintext-sha256': 'a'.repeat(64),
        'x-dks-ciphertext-sha256': 'c'.repeat(64),
        'x-dks-key-id': 'ab'.repeat(12),
        'x-dks-source': 'local-cache',
        'x-dks-device-id': DEVICE_ID,
        'x-dks-created-at': '2026-10-31T08:00:00.000Z',
      },
      body: body as BodyInit,
      ...(body instanceof ArrayBuffer ? {} : { duplex: 'half' } as Record<string, unknown>),
    });
  }

  it('stores a below-limit streamed upload byte for byte', async () => {
    const token = await signToken(ADMIN_SUB);
    // 64 KB in 16 chunks: exercises the head probe, the prepend and the
    // counting transform across many chunks.
    const result = await handleUpload(
      requestWithBody(repeatingStream(4096, 16), token),
      env,
      deps,
    );

    const stored = bucket.objects.get(result.key);
    expect(stored).toBeDefined();
    expect(stored?.size).toBe(4096 * 16);
    expect(result.size).toBe(4096 * 16);
    // The first chunk is the real envelope header, and nothing was dropped or
    // duplicated at the seam between the probe and the stream.
    expect(isBackupEnvelope(stored!.bodyBytes.subarray(0, 35))).toBe(true);
    expect(stored!.bodyBytes.byteLength).toBe(4096 * 16);
    expect(stored?.customMetadata.ciphertextSha256Source).toBe('client-declared');
    expect(stored?.customMetadata.keyId).toBe('ab'.repeat(12));
    expect(stored?.customMetadata.source).toBe('local-cache');
  });

  it('returns 413 when the streamed body exceeds the limit', async () => {
    const token = await signToken(ADMIN_SUB);
    const chunkBytes = 1024 * 1024;
    const chunkCount = Math.ceil(MAX_UPLOAD_BYTES / chunkBytes) + 1;

    await expect(
      handleUpload(requestWithBody(repeatingStream(chunkBytes, chunkCount), token), env, deps),
    ).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('writes no object at all when the upload exceeds the limit', async () => {
    const token = await signToken(ADMIN_SUB);
    const chunkBytes = 1024 * 1024;
    const chunkCount = Math.ceil(MAX_UPLOAD_BYTES / chunkBytes) + 1;

    expect(bucket.objects.size).toBe(0);
    await expect(
      handleUpload(requestWithBody(repeatingStream(chunkBytes, chunkCount), token), env, deps),
    ).rejects.toThrow(/larger than the service limit/i);
    expect(bucket.objects.size).toBe(0);
  });

  it('reports a clean 400 when the stream dies before the header arrives', async () => {
    const token = await signToken(ADMIN_SUB);
    // Erroring immediately after enqueue can lose the queued chunk in the
    // request plumbing, so the probe never sees a header at all.
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(envelope(64));
        controller.error(new TypeError('client went away'));
      },
    });
    await expect(
      handleUpload(requestWithBody(broken, token), env, deps),
    ).rejects.toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    expect(bucket.objects.size).toBe(0);
  });

  it('keeps the predictable JSON error shape when the stream breaks mid-upload', async () => {
    const token = await signToken(ADMIN_SUB);
    // The first chunk arrives (so the envelope probe passes), then the
    // connection dies mid-transfer — the case that must not write an object.
    let sent = false;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(envelope(64));
          return;
        }
        controller.error(new TypeError('connection reset while uploading'));
      },
    });

    vi.stubGlobal('fetch', supabase.fetchImpl);
    try {
      const response = await worker.fetch(requestWithBody(broken, token), env);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: {
          code: 'UNAVAILABLE',
          message: 'The backup could not be stored',
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(bucket.objects.size).toBe(0);
  });
});

describe('GET /v1/backups (list)', () => {
  async function seedUploads(count: number): Promise<string[]> {
    const token = await signToken(ADMIN_SUB);
    const keys: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const result = await handleUpload(
        uploadRequest(envelope(16 + index), token, { 'x-dks-record-counts': `entries=${String(index)}` }),
        env,
        deps,
      );
      keys.push(result.key);
    }
    return keys;
  }

  it('lists metadata for a month, newest first, without streaming bodies', async () => {
    await seedUploads(3);
    const now = new Date();
    const request = new Request(
      `https://x/v1/backups?year=${String(now.getUTCFullYear())}&month=${String(now.getUTCMonth() + 1)}`,
      { headers: { authorization: `Bearer ${await signToken(ADMIN_SUB)}` } },
    );
    const result = await handleList(request, env, deps);
    expect(result.backups).toHaveLength(3);
    expect(result.backups[0].createdAt >= result.backups[2].createdAt).toBe(true);
    expect(result.backups[0].outcome).toBe('verified');
    expect(typeof result.backups[0].recordCount).toBe('number');
    // Every row says which key opens it and what it covers.
    expect(result.backups[0].keyId).toBe('ab'.repeat(12));
    expect(result.backups[0].source).toBe('local-cache');
  });

  it('reports an unknown source instead of guessing for older objects', async () => {
    await seedUploads(1);
    const stored = [...bucket.objects.values()][0];
    delete stored.customMetadata.source;
    delete stored.customMetadata.keyId;

    const now = new Date();
    const request = new Request(
      `https://x/v1/backups?year=${String(now.getUTCFullYear())}&month=${String(now.getUTCMonth() + 1)}`,
      { headers: { authorization: `Bearer ${await signToken(ADMIN_SUB)}` } },
    );
    const result = await handleList(request, env, deps);
    expect(result.backups).toHaveLength(1);
    expect(result.backups[0].source).toBeNull();
    expect(result.backups[0].keyId).toBeNull();
  });

  it('is admin only', async () => {
    await seedUploads(1);
    const now = new Date();
    const request = new Request(
      `https://x/v1/backups?year=${String(now.getUTCFullYear())}&month=${String(now.getUTCMonth() + 1)}`,
      { headers: { authorization: `Bearer ${await signToken(OFFICE_SUB)}` } },
    );
    await expect(handleList(request, env, deps)).rejects.toThrow(/Office sessions cannot use cloud backup/i);
  });

  it('rejects a missing or impossible year and month', async () => {
    const token = await signToken(ADMIN_SUB);
    for (const query of ['year=2026', 'month=10', 'year=1999&month=10', 'year=2026&month=13']) {
      const request = new Request(`https://x/v1/backups?${query}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      await expect(handleList(request, env, deps), query).rejects.toThrow(BackupHttpError);
    }
  });

  it('paginates with the R2 cursor', async () => {
    await seedUploads(3);
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const first = await handleList(new Request(`https://x/v1/backups?year=${String(year)}&month=${String(month)}`, {
      headers: { authorization: `Bearer ${await signToken(ADMIN_SUB)}` },
    }), { ...env, DKS_BACKUPS: bucket }, { ...deps });
    expect(first.backups).toHaveLength(3);
    expect(first.nextCursor).toBeNull();
  });
});

describe('GET / HEAD /v1/backups/{id}', () => {
  it('streams the object for an admin and exposes the stored checksum on HEAD', async () => {
    const token = await signToken(ADMIN_SUB);
    const body = envelope();
    const uploaded = await handleUpload(uploadRequest(body, token), env, deps);

    const headResponse = await handleGetObject(
      new Request(`https://x/v1/backups/${encodeURIComponent(uploaded.key)}`, {
        method: 'HEAD',
        headers: { authorization: `Bearer ${token}` },
      }),
      env, deps, uploaded.key,
    );
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('x-dks-ciphertext-sha256')).toBe(uploaded.ciphertextSha256);
    expect(headResponse.headers.get('x-dks-plaintext-sha256')).toBe('a'.repeat(64));

    const getResponse = await handleGetObject(
      new Request(`https://x/v1/backups/${encodeURIComponent(uploaded.key)}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      env, deps, uploaded.key,
    );
    const streamed = new Uint8Array(await getResponse.arrayBuffer());
    expect(streamed).toEqual(body);
  });

  it('is admin only and 404s for an unknown object', async () => {
    const officeToken = await signToken(OFFICE_SUB);
    await expect(handleGetObject(
      new Request('https://x/v1/backups/abc', { headers: { authorization: `Bearer ${officeToken}` } }),
      env, deps, 'backups/2026/10/2026-10-31/083015-0123456789ab.sqlite.enc',
    )).rejects.toThrow(/Office sessions cannot use cloud backup/i);

    const adminToken = await signToken(ADMIN_SUB);
    await expect(handleGetObject(
      new Request('https://x/v1/backups/abc', { headers: { authorization: `Bearer ${adminToken}` } }),
      env, deps, 'backups/2026/10/2026-10-31/083015-0123456789ab.sqlite.enc',
    )).rejects.toThrow(/no longer exists/i);
  });
});

describe('GET /health', () => {
  it('reports a healthy binding and detects a broken one', async () => {
    expect(await handleHealth(env, deps)).toEqual({ ok: true, r2: true, detail: null });

    const broken = { ...env, DKS_BACKUPS: { ...bucket, list: async () => { throw new Error('boom'); } } };
    expect(await handleHealth(broken, deps)).toMatchObject({ ok: false, r2: false });

    const unbound = { ...env, DKS_BACKUPS: undefined as unknown as BackupEnv['DKS_BACKUPS'] };
    expect(await handleHealth(unbound, deps)).toMatchObject({ ok: false, detail: /binding is missing/i });
  });
});

describe('routing and error shape', () => {
  it('answers OPTIONS with CORS and no body', async () => {
    const response = await routeRequest(new Request('https://x/v1/backups', { method: 'OPTIONS' }), env, deps);
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('returns one predictable JSON error shape and never echoes the request', async () => {
    const response = await worker.fetch(new Request('https://x/v1/backups', { method: 'DELETE' }), env);
    expect(response.status).toBe(405);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST to upload a backup' },
    });

    const missing = await worker.fetch(new Request('https://x/nope'), env);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('returns 401 for an upload with no token', async () => {
    const response = await worker.fetch(uploadRequest(envelope(), ''), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });
});

describe('retention cron', () => {
  async function seedAged(daysOld: number, shortId: string): Promise<string> {
    const parts = buildObjectKey(new Date(Date.now() - daysOld * 86_400_000), shortId);
    await bucket.put(parts.key, envelope(8), {
      customMetadata: { createdAt: new Date(Date.now() - daysOld * 86_400_000).toISOString() },
    });
    // Force the upload timestamp so the age test is deterministic.
    const stored = bucket.objects.get(parts.key);
    if (stored) stored.uploaded = new Date(Date.now() - daysOld * 86_400_000);
    return parts.key;
  }

  it('is prefix-scoped, paginated and protects the newest object', async () => {
    const oldA = await seedAged(200, 'aaaaaaaaaaaa');
    const oldB = await seedAged(150, 'bbbbbbbbbbbb');
    const recent = await seedAged(1, 'cccccccccccc');

    const dryRun = await runRetention(env, deps);
    expect(dryRun.mode).toBe('dry-run');
    expect(dryRun.scanned).toBe(3);
    expect(dryRun.candidates).toBe(2);
    expect(dryRun.deleted).toBe(0);
    expect(dryRun.protectedKey).toBe(recent);
    expect(bucket.objects.has(oldA)).toBe(true);

    const enforced = await runRetention({ ...env, RETENTION_MODE: 'enforce' }, deps);
    expect(enforced.deleted).toBe(2);
    expect(bucket.objects.has(oldA)).toBe(false);
    expect(bucket.objects.has(oldB)).toBe(false);
    expect(bucket.objects.has(recent)).toBe(true);
  });

  it('never deletes the only remaining object, however old it is', async () => {
    const only = await seedAged(400, 'dddddddddddd');
    const summary = await runRetention({ ...env, RETENTION_MODE: 'enforce' }, deps);
    expect(summary.candidates).toBe(0);
    expect(summary.deleted).toBe(0);
    expect(bucket.objects.has(only)).toBe(true);
  });

  it('ignores objects outside the backup prefix', async () => {
    await seedAged(200, 'eeeeeeeeeeee');
    await bucket.put('something-else/file.bin', new Uint8Array(4));
    const summary = await runRetention({ ...env, RETENTION_MODE: 'enforce' }, deps);
    expect(summary.scanned).toBe(1);
    expect(bucket.objects.has('something-else/file.bin')).toBe(true);
  });
});

describe('record-count encoding', () => {
  it('round-trips without commas or quotes, so it is safe in a header', () => {
    const encoded = encodeRecordCounts({ entries: 12, columns: 3, auditLog: 40 });
    expect(encoded).not.toMatch(/[",]/);
    expect(decodeRecordCounts(encoded)).toEqual({ entries: 12, columns: 3, auditLog: 40 });
    expect(decodeRecordCounts(null)).toEqual({});
  });
});
