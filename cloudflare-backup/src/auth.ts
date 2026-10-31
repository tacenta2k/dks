/**
 * Cloudflare backup Worker — authentication.
 *
 * Trust model, in order:
 *   1. The Supabase JWT is verified cryptographically against Supabase's own
 *      JWKS (RS256, cached). Nothing else about the caller is trusted.
 *   2. The role is looked up in Postgres through PostgREST with the USER's JWT
 *      and the public anon key. Row Level Security means the query can only
 *      ever return the caller's own profile row, so a client cannot assert a
 *      role and a stolen anon key cannot read anybody else's.
 *   3. Office uploads additionally require the existing server-side approval
 *      check, `public.office_session_is_approved()` — a SECURITY DEFINER RPC
 *      that reads `auth.jwt()` itself. It is reused verbatim from
 *      ARENA/sql/office-approval.sql; no new RPC was added for backups.
 *
 * There is no service-role key in this Worker, and no R2 credential in the
 * desktop app. Destructive operations (PR2 delete, PR3 restore) will
 * additionally require a fresh email-OTP step-up; the hook is present and
 * refuses, and no destructive route is registered.
 */

/** Minimal structural R2 surface — no @cloudflare/workers-types dependency. */
export interface R2Object {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
  customMetadata: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListResult {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array | ReadableStream, options?: {
    httpMetadata?: Record<string, string>;
    customMetadata?: Record<string, string>;
  }): Promise<R2Object>;
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListResult>;
  delete(keys: string | string[]): Promise<void>;
}

export interface BackupEnv {
  DKS_BACKUPS: R2BucketLike;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  /** 'dry-run' (default) logs retention candidates; only 'enforce' deletes. */
  RETENTION_MODE?: string;
  RETENTION_DAYS?: string;
  /**
   * Accepted JWT `aud`. Defaults to Supabase's `authenticated`; set only if the
   * project issues access tokens with a different audience.
   */
  SUPABASE_JWT_AUDIENCE?: string;
}

export interface AuthDeps {
  fetchImpl: typeof fetch;
  now: () => number;
}

export interface JwtClaims {
  sub: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  session_id?: string;
  email?: string;
}

export type CallerRole = 'admin' | 'office';

export interface AuthenticatedCaller {
  claims: JwtClaims;
  role: CallerRole;
  /** Office only: the server-side approval RPC returned true. */
  officeApproved: boolean;
}

export type BackupErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'METHOD_NOT_ALLOWED'
  | 'STEP_UP_REQUIRED'
  | 'UNAVAILABLE'
  | 'INTERNAL'
  /** v1 policy: an Office session may not touch cloud backup at all. */
  | 'OFFICE_NOT_ALLOWED'
  /** The uploading PC is not the one designated in `public.settings`. */
  | 'DEVICE_NOT_DESIGNATED';

export class BackupHttpError extends Error {
  public readonly status: number;
  public readonly code: BackupErrorCode;

  public constructor(status: number, code: BackupErrorCode, message: string) {
    super(message);
    this.name = 'BackupHttpError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// JWKS cache
// ---------------------------------------------------------------------------

interface JsonWebKeySet {
  keys: Array<{ kid?: string; kty?: string; alg?: string; n?: string; e?: string; use?: string }>;
}

const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map<string, { at: number; keys: JsonWebKeySet['keys'] }>();

/** Test hook: drop the cached JWKS and imported keys. */
export function resetJwksCacheForTests(): void {
  jwksCache.clear();
  keyCache.clear();
}

/** Supabase signs access tokens with `iss` = `<project>/auth/v1`. */
export function expectedIssuer(env: BackupEnv): string {
  return `${String(env.SUPABASE_URL).replace(/\/+$/, '')}/auth/v1`;
}

/** Supabase's audience for a signed-in user's access token. */
export const DEFAULT_JWT_AUDIENCE = 'authenticated';

/** The one accepted `aud` value; overridable only via `SUPABASE_JWT_AUDIENCE`. */
export function expectedAudience(env: BackupEnv): string {
  const override = typeof env.SUPABASE_JWT_AUDIENCE === 'string' ? env.SUPABASE_JWT_AUDIENCE.trim() : '';
  return override.length > 0 ? override : DEFAULT_JWT_AUDIENCE;
}

export function jwksUrl(env: BackupEnv): string {
  return `${String(env.SUPABASE_URL).replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
}

/**
 * Read Supabase's JWKS, cached for {@link JWKS_TTL_MS}.
 *
 * `force` bypasses the cache. It is used exactly once when a token presents a
 * `kid` the cache does not know, so a key rotation cannot lock the Worker out
 * for up to ten minutes — while an attacker still cannot make the Worker fetch
 * per request, because the retry happens only after the cache lookup misses.
 */
async function loadJwks(env: BackupEnv, deps: AuthDeps, force = false): Promise<JsonWebKeySet['keys']> {
  const url = jwksUrl(env);
  const cached = jwksCache.get(url);
  if (!force && cached && deps.now() - cached.at < JWKS_TTL_MS) {
    return cached.keys;
  }
  let response: Response;
  try {
    response = await deps.fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch {
    // Serve stale rather than failing every request during a brief JWKS outage.
    if (cached) return cached.keys;
    throw new BackupHttpError(503, 'UNAVAILABLE', 'The signing keys could not be reached');
  }
  if (!response.ok) {
    if (cached) return cached.keys;
    throw new BackupHttpError(503, 'UNAVAILABLE', 'The signing keys could not be read');
  }
  const parsed = await response.json() as Partial<JsonWebKeySet> | null;
  const keys = Array.isArray(parsed?.keys) ? parsed?.keys ?? [] : [];
  if (keys.length === 0) {
    if (cached) return cached.keys;
    throw new BackupHttpError(503, 'UNAVAILABLE', 'The signing key set is empty');
  }
  jwksCache.set(url, { at: deps.now(), keys });
  return keys;
}

// ---------------------------------------------------------------------------
// JWT verification (RS256 only)
// ---------------------------------------------------------------------------

/** Decode base64url into a plain-ArrayBuffer-backed view WebCrypto accepts. */
function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

/**
 * WebCrypto's `BufferSource` in TS 5.7 rejects `Uint8Array<ArrayBufferLike>`
 * (it could be a SharedArrayBuffer). Every buffer here is a fresh ArrayBuffer,
 * so narrowing at the boundary is sound and keeps the code free of `any`.
 */
function bufferSource(bytes: Uint8Array): BufferSource {
  return bytes.buffer as ArrayBuffer;
}

const keyCache = new Map<string, CryptoKey>();

async function importRsaKey(kid: string, jwk: JsonWebKeySet['keys'][number]): Promise<CryptoKey> {
  const cachedKey = keyCache.get(kid);
  if (cachedKey) return cachedKey;
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new BackupHttpError(503, 'UNAVAILABLE', 'The signing key is not an RSA key');
  }
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  keyCache.set(kid, key);
  return key;
}

/**
 * Verify a Supabase access token. Only RS256 is accepted, and the signature is
 * checked over the exact received `header.payload` bytes — never over a
 * re-serialised copy of the claims.
 */
export async function verifySupabaseJwt(
  token: string,
  env: BackupEnv,
  deps: AuthDeps,
): Promise<JwtClaims> {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new BackupHttpError(401, 'UNAUTHORIZED', 'A sign-in token is required');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new BackupHttpError(401, 'UNAUTHORIZED', 'The sign-in token is malformed');
  }
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerPart))) as { alg?: string; kid?: string };
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart))) as Record<string, unknown>;
  } catch {
    throw new BackupHttpError(401, 'UNAUTHORIZED', 'The sign-in token is malformed');
  }

  // HS256 (legacy Supabase JWT secret) is deliberately refused: the Worker only
  // ever holds the public JWKS, never a symmetric secret.
  if (header.alg !== 'RS256') {
    throw new BackupHttpError(401, 'UNAUTHORIZED', 'Only RS256 access tokens are accepted');
  }

  const matches = (keys: JsonWebKeySet['keys']) => header.kid
    ? keys.find((candidate) => candidate.kid === header.kid)
    : keys.find((candidate) => candidate.kty === 'RSA');

  let jwk = matches(await loadJwks(env, deps));
  if (!jwk) {
    // Unknown kid: the key may have rotated inside the cache window. Refresh
    // once, then reject — never in a loop.
    jwk = matches(await loadJwks(env, deps, true));
  }
  if (!jwk) {
    throw new BackupHttpError(401, 'UNAUTHORIZED', 'The signing key for this token is unknown');
  }
  const key = await importRsaKey(jwk.kid ?? 'default', jwk);

  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      bufferSource(base64UrlDecode(signaturePart)),
      bufferSource(signed),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw new BackupHttpError(401, 'UNAUTHORIZED', 'The sign-in token signature is invalid');
  }

  const nowSeconds = Math.floor(deps.now() / 1000);
  const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
  if (exp !== undefined && nowSeconds >= exp) {
    throw new BackupHttpError(401, 'UNAUTHORIZED', 'The sign-in session has expired');
  }
  const nbf = typeof payload.nbf === 'number' ? payload.nbf : undefined;
  if (nbf !== undefined && nowSeconds + 30 < nbf) {
    throw new BackupHttpError(401, 'UNAUTHORIZED', 'The sign-in token is not valid yet');
  }

  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.trim().length === 0) {
    throw new BackupHttpError(401, 'UNAUTHORIZED', 'The sign-in token has no subject');
  }

  // Issuer and audience are compared exactly. Together they refuse a token
  // minted by a different Supabase project and a `service_role`/`anon` token
  // from this one, even in the unlikely event such a signature verified.
  const iss = typeof payload.iss === 'string' ? payload.iss : '';
  if (iss !== expectedIssuer(env)) {
    throw new BackupHttpError(401, 'UNAUTHORIZED', 'The sign-in token was not issued by this project');
  }
  const audience = payload.aud;
  const audiences = (Array.isArray(audience) ? audience : [audience]).filter((value): value is string => typeof value === 'string');
  if (!audiences.includes(expectedAudience(env))) {
    throw new BackupHttpError(401, 'UNAUTHORIZED', 'The sign-in token audience is not accepted');
  }

  return {
    sub,
    ...(exp !== undefined ? { exp } : {}),
    ...(typeof payload.iat === 'number' ? { iat: payload.iat } : {}),
    ...(typeof payload.session_id === 'string' ? { session_id: payload.session_id } : {}),
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
  };
}

// ---------------------------------------------------------------------------
// Role lookup — PostgREST + RLS, with the USER's JWT and the public anon key
// ---------------------------------------------------------------------------

function restBase(env: BackupEnv): string {
  return `${String(env.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1`;
}

/**
 * `GET /rest/v1/profiles?id=eq.{sub}&select=role`
 *
 * RLS on `profiles` allows only the caller's own row, so the answer is either
 * the caller's role or nothing. A `role` in the request body is never read.
 */
export async function lookupCallerRole(
  claims: JwtClaims,
  token: string,
  env: BackupEnv,
  deps: AuthDeps,
): Promise<CallerRole | null> {
  const url = `${restBase(env)}/profiles?id=eq.${encodeURIComponent(claims.sub)}&select=role`;
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
  } catch {
    throw new BackupHttpError(503, 'UNAVAILABLE', 'The role could not be checked');
  }
  if (!response.ok) {
    throw new BackupHttpError(response.status === 401 ? 401 : 403, response.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', 'The role could not be checked');
  }
  const rows = await response.json() as unknown;
  const role = Array.isArray(rows) && rows.length > 0
    ? (rows[0] as { role?: unknown }).role
    : null;
  if (role === 'admin') return 'admin';
  if (role === 'office') return 'office';
  return null;
}

/**
 * `POST /rest/v1/rpc/office_session_is_approved` — the existing SECURITY
 * DEFINER approval check from ARENA/sql/office-approval.sql. It derives the
 * session from `auth.jwt()` server-side, so this Worker never has to trust (or
 * even see) an approval claim.
 */
export async function lookupOfficeApproval(
  token: string,
  env: BackupEnv,
  deps: AuthDeps,
): Promise<boolean> {
  const url = `${restBase(env)}/rpc/office_session_is_approved`;
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: '{}',
    });
  } catch {
    throw new BackupHttpError(503, 'UNAVAILABLE', 'The sign-in approval could not be checked');
  }
  if (!response.ok) {
    throw new BackupHttpError(403, 'FORBIDDEN', 'The sign-in approval could not be checked');
  }
  const result = await response.json() as unknown;
  return result === true;
}

/** Extract and validate the bearer token. */
export function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    throw new BackupHttpError(401, 'UNAUTHORIZED', 'A sign-in token is required');
  }
  return match[1].trim();
}

/** Fully authenticate a request: valid JWT, real role, and Office approval. */
export async function authenticate(
  request: Request,
  env: BackupEnv,
  deps: AuthDeps,
): Promise<AuthenticatedCaller & { token: string }> {
  const token = bearerToken(request);
  const claims = await verifySupabaseJwt(token, env, deps);
  const role = await lookupCallerRole(claims, token, env, deps);
  if (!role) {
    throw new BackupHttpError(403, 'FORBIDDEN', 'This account cannot use cloud backup');
  }
  const officeApproved = role === 'office' ? await lookupOfficeApproval(token, env, deps) : true;
  if (role === 'office' && !officeApproved) {
    throw new BackupHttpError(403, 'FORBIDDEN', 'This Office session has not been approved');
  }
  return { claims, role, officeApproved, token };
}

/** Admin-only routes: listing and downloading backups. */
/**
 * The gate for **every** backup operation in v1 — upload, list, download.
 *
 * Admin only. An Office session is refused with `OFFICE_NOT_ALLOWED` whether or
 * not its sign-in approval is valid, so no approval state can widen access to
 * backups and the Worker never even calls the approval RPC for this path.
 *
 * Trust order, unchanged: verify the JWT (RS256, signature over the exact
 * received bytes, exp/nbf/sub/iss/aud), then read the caller's `role` from
 * Postgres with the caller's own token under RLS. `app_metadata` and any role
 * in the request body or headers are never read.
 */
export async function requireBackupAdmin(
  request: Request,
  env: BackupEnv,
  deps: AuthDeps,
): Promise<AuthenticatedCaller & { token: string }> {
  const token = bearerToken(request);
  const claims = await verifySupabaseJwt(token, env, deps);
  const role = await lookupCallerRole(claims, token, env, deps);
  if (!role) {
    throw new BackupHttpError(403, 'FORBIDDEN', 'This account cannot use cloud backup');
  }
  if (role === 'office') {
    throw new BackupHttpError(
      403,
      'OFFICE_NOT_ALLOWED',
      'Office sessions cannot use cloud backup, approved or not',
    );
  }
  if (role !== 'admin') {
    throw new BackupHttpError(403, 'FORBIDDEN', 'Only administrators can use cloud backup');
  }
  return { claims, role, officeApproved: false, token };
}

/** Row key in `public.settings` that holds the shared, authoritative designation. */
export const DESIGNATED_DEVICE_KEY = 'dks.backup.designated_device';

/** Opaque random device id shape: 16 random bytes, hex. Never derived from PII. */
export const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/i;

export interface DesignatedDevice {
  deviceId: string;
  /** Human-readable label chosen by the administrator. Must carry no PII. */
  label: string;
  designatedAt: string | null;
}

/**
 * Read the designated backup PC from `public.settings`, with the CALLER's JWT.
 *
 * This is the server-side enforcement point for "only one PC uploads": RLS on
 * `public.settings` allows INSERT/UPDATE/DELETE for Admins only, so the row is
 * authoritative and a local "I am designated" flag on a second PC cannot
 * substitute for it. Nothing is cached here — the answer is read per upload.
 *
 * Fails closed: an unreadable settings row is a 5xx, never "no designation".
 */
export async function lookupDesignatedDevice(
  token: string,
  env: BackupEnv,
  deps: AuthDeps,
): Promise<DesignatedDevice | null> {
  const url = `${restBase(env)}/settings?key=eq.${encodeURIComponent(DESIGNATED_DEVICE_KEY)}&select=value`;
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
  } catch {
    throw new BackupHttpError(503, 'UNAVAILABLE', 'The designated backup PC could not be checked');
  }
  if (!response.ok) {
    throw new BackupHttpError(
      response.status === 401 ? 401 : 503,
      response.status === 401 ? 'UNAUTHORIZED' : 'UNAVAILABLE',
      'The designated backup PC could not be checked',
    );
  }
  const rows = await response.json() as unknown;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const value = (rows[0] as { value?: unknown }).value;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { deviceId?: unknown; label?: unknown; designatedAt?: unknown };
  const deviceId = typeof record.deviceId === 'string' ? record.deviceId.trim().toLowerCase() : '';
  if (!DEVICE_ID_PATTERN.test(deviceId)) return null;
  return {
    deviceId,
    // Length-capped so a long label cannot become a metadata or log problem.
    label: typeof record.label === 'string' ? record.label.slice(0, 60) : '',
    designatedAt: typeof record.designatedAt === 'string' ? record.designatedAt : null,
  };
}

export async function requireAdmin(
  request: Request,
  env: BackupEnv,
  deps: AuthDeps,
): Promise<AuthenticatedCaller & { token: string }> {
  return requireBackupAdmin(request, env, deps);
}

/**
 * Step-up hook for destructive operations (PR2 delete, PR3 restore).
 *
 * Design: the client requests a one-time email OTP from Supabase
 * (`POST /auth/v1/otp`), the user types the code, and the destructive request
 * carries the verified OTP token in `x-dks-step-up`. This Worker would verify
 * that token as a second, fresh authentication and require its `iat` to be
 * inside a short window. It is intentionally NOT enabled in PR1 — no
 * destructive route is registered, and this always refuses.
 */
export function requireStepUp(_request: Request): never {
  throw new BackupHttpError(
    403,
    'STEP_UP_REQUIRED',
    'Deleting or restoring backups is not available yet',
  );
}
