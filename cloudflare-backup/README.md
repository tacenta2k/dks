# DKS cloud backup Worker

Receives encrypted DKS backups from the desktop app and stores them in a
**private** Cloudflare R2 bucket. This is PR1: upload, list, download and a
health check. Delete (PR2) and replace-restore (PR3) are deliberately absent.

## What it does

| Route | Who | What |
| --- | --- | --- |
| `POST /v1/backups` | Admin, or an approved Office session | **Stream** one `DKSBK1` envelope into R2 (max 200 MB, enforced while streaming). The server generates the object key. |
| `GET /v1/backups?year&month` | Admin only | List object **metadata** with R2 cursor pagination. Never downloads bodies. |
| `GET /v1/backups/{id}` | Admin only | Stream one object. |
| `HEAD /v1/backups/{id}` | Admin only | Metadata plus the recorded checksum, so the app can re-hash what it downloads. |
| `GET /health` | Public | Liveness and R2 binding check. No PII. |

Object keys are generated here and nowhere else:

```
backups/{yyyy}/{mm}/{yyyy-mm-dd}/{hhmmss}-{shortid}.sqlite.enc
```

The date parts come from the server clock in **Asia/Muscat** (no DST), matching
the calendar the DKS history groups by. A client-supplied path is never used:
`GET`/`HEAD` validate the id against the exact shape above and refuse anything
else, so traversal is not reachable.

## Uploads are streamed, and the checksum is client-declared

A Worker isolate has **128 MB of memory on every plan** and that cannot be
raised, so `handleUpload` never buffers the body:

1. It reads only the first **7 bytes** (magic + version) to refuse anything that
   is not a `DKSBK1` envelope.
2. Those bytes are replayed and the rest of `request.body` flows through a
   `TransformStream` that counts bytes.
3. Passing `MAX_UPLOAD_BYTES` (200 MB) errors the stream, the `put` rejects, the
   client gets `413 PAYLOAD_TOO_LARGE`, and **no object is written**. The limit
   does not depend on `content-length`; that header is only a cheap early
   refusal.

Consequence, deliberately not hidden: **this Worker cannot compute a SHA-256
over the ciphertext**, because it never holds it and WebCrypto has no streaming
digest. The `ciphertextSha256` stored with the object is the one the desktop app
declared in `x-dks-ciphertext-sha256`, recorded alongside
`ciphertextSha256Source: client-declared` and echoed on `HEAD`/`GET` with
`x-dks-ciphertext-sha256-source`. The app re-hashes the bytes it downloads and
compares, which detects truncation and corruption in transit and at rest — but
it is not independent server-side evidence. Independent integrity comes from the
AES-GCM tag and the AAD-bound plaintext SHA-256 at decrypt time.

Upload headers: `x-dks-plaintext-sha256` (required, 64-hex),
`x-dks-ciphertext-sha256` (required, 64-hex, client-declared),
`x-dks-created-at` (required), `x-dks-fingerprint`, `x-dks-schema-version`,
`x-dks-record-counts` (`k=v;k=v`), `x-dks-app-version`, `x-dks-key-id`
(24-hex — which recovery key opens the object) and `x-dks-source`
(always `local-cache` in PR1: a snapshot of one PC's local cache, never an
authoritative copy).

## Trust model

1. The Supabase JWT is verified against Supabase's own JWKS (`RS256`, cached for
   10 minutes). `HS256` tokens are refused — the Worker holds no symmetric
   secret.
2. The role comes from Postgres:
   `GET /rest/v1/profiles?id=eq.{sub}&select=role` using the **user's** JWT and
   the public anon key. RLS means the query can only return the caller's own
   row. A `role` in the request body is never read.
3. Office uploads additionally require `public.office_session_is_approved()` —
   the existing `SECURITY DEFINER` RPC from `ARENA/sql/office-approval.sql`,
   called with the user's JWT. No new RPC was added for backups.

There is **no service-role key** and **no R2 credential** in the desktop app.

## Setup (owner)

```bash
# 1. Cloudflare account + wrangler
npm install -g wrangler
wrangler login

# 2. Private R2 bucket (once)
wrangler r2 bucket create dks-backups

# 3. Secrets — never commit these
wrangler secret put SUPABASE_URL        # https://<project>.supabase.co
wrangler secret put SUPABASE_ANON_KEY   # the PUBLIC anon/publishable key

# 4. Deploy
cd cloudflare-backup
wrangler deploy
```

`wrangler deploy` prints the Worker URL, for example
`https://dks-backup.<account-subdomain>.workers.dev`. Paste that into
DKS → Settings → Backup & recovery → **Backup service address**.

Do not enable R2 public access, an `r2.dev` subdomain or a custom public
domain for `dks-backups`.

## Retention cron

`wrangler.toml` schedules `17 2 * * *` (daily, 02:17 UTC). In PR1 it runs in
**dry-run**: it scans, counts the objects older than `RETENTION_DAYS`
(default 90) and logs them, always protecting the newest object. It deletes
nothing. Deleting requires:

```bash
wrangler secret put RETENTION_MODE   # value: enforce
```

and that switch is a PR2 decision.

## Step-up (PR2/PR3 hook)

Destructive operations will require a fresh email-OTP step-up on top of the
role check. `requireStepUp()` in `src/auth.ts` is the hook; in PR1 it always
refuses with `STEP_UP_REQUIRED`, and no route calls it.

## Errors

Every failure returns one shape:

```json
{ "error": { "code": "FORBIDDEN", "message": "Only administrators can read backups" } }
```

Codes: `UNAUTHORIZED`, `FORBIDDEN`, `BAD_REQUEST`, `NOT_FOUND`,
`PAYLOAD_TOO_LARGE`, `METHOD_NOT_ALLOWED`, `STEP_UP_REQUIRED`, `UNAVAILABLE`,
`INTERNAL`. Messages are fixed strings. Nothing from a request body, an
`authorization` header or a stored object is echoed back or logged.

## Requirement note

The project's Supabase auth must issue JWTs signed with the JWKS key set
(`RS256`). Projects still on the legacy `HS256` JWT secret will be refused;
migrate the project's API keys in the Supabase dashboard before relying on
cloud backup.
