# Cloud backup — Phase 1 (PR1) implementation report

Date: 2026-10-31 · Branch: `arena/38587425-dks` (from `main` @ `57c49ce`, tag `v0.1.11`)
Scope shipped: snapshot → encrypt → upload → list → download → test-restore drill → admin status UI → Cloudflare Worker.
**Not shipped (by design):** delete, restore. Their interfaces are reserved but unreachable.

---

## 1. Audit findings and deviations

### 1.1 Blocking conflict — branch name (reported, not acted on)

The brief asked for a branch `feat/cloud-backup-phase1` created from `main` (v0.1.11).
This session is pinned to `arena/38587425-dks` and branch create/switch is forbidden here,
so the work sits on `arena/38587425-dks`, which is branched from the same commit
(`57c49ce`, tag `v0.1.11`). Nothing was committed, merged, tagged or published, and
`package.json` is untouched (still `0.1.11`). All pre-existing uncommitted work is intact.
If you want the `feat/cloud-backup-phase1` name, this tree can be committed and pushed to
that branch from your side, or I can do it once branch changes are allowed.

### 1.2 Audit findings

| Area | Finding | Consequence for this PR |
| --- | --- | --- |
| Guide | `AGENT_REPO_GUIDE.md` does **not** exist. The real entry point is `HANDOFF.md`, which points at `docs/RESUME_NEXT_SESSION.md` and `docs/FIXES_UI.md`. | Audited those three instead. `docs/FIXES_UI.md` is marked LOCKED and was **not** edited. |
| SQLite store | `electron/main/sqlite.ts` (~2.5k lines) keeps migrations in a `MIGRATIONS` array, `SQLITE_SCHEMA_VERSION = 4`, `foreign_keys=ON`, WAL. Tables are `columns`, `entries`, `audit_log`, `notifications`, `outbox`, `conflicts`, `sync_meta`, `local_settings`, `error_report_queue`, `error_report_dedupe`. | The brief's names `app_columns`/`settings` do not exist locally (they are the **Supabase** names). Snapshot covers `columns` and `local_settings`; the audit mirror is `audit_log`. |
| Migrations | `tests/error-reporting-privacy-and-queue.test.ts:215` pins `getMigrationVersion()` to **4** and rewinds to v3 by dropping `error_report_*`. | No 5th migration. Backup state lives in `sync_meta` (`dks.backup.state`, `dks.backup.keyHash`, `dks.backup.events`). Added `ensureBaseSchema()` — CREATE-only statements run on **every** open — so a snapshot copy that has tables dropped in it re-opens cleanly. |
| Outbox / sync | `createEntry` enqueues one outbox row; `getOutboxSummary()` counts `status <> 'synced'`. `syncOutbox(store, transport, now)` is the drain path. | Bounded pre-snapshot drain (10 s budget, 400 ms poll); otherwise the run records `snapshot incomplete: pending local changes` and retries. |
| Auth / session | Supabase JWT lives in Electron session storage; the renderer holds `session.access_token` (`App.tsx`). Main cannot see it. | One extra IPC channel, `dks:backup:set-session`, pushes the credential (8th channel — deviation, see 1.3). Modelled on `dks:local:set-session-clearance`. |
| Office approval | `public.office_session_is_approved()` (`ARENA/sql/office-approval.sql`, `SECURITY DEFINER`, granted to `authenticated` at L331) already answers exactly the Worker's question. | Reused as-is. **No new `ARENA/sql/` file.** |
| IPC / preload | `diagnostics-ipc.ts` is the house pattern: frozen channel map, `assertAdminAuthorized`, `registerX({ipcMain,…})` returning an unregister fn. Preload validates then `invoke`s. | `backup-ipc.ts` follows it exactly; preload gained `backup:` validators and a frozen `backupApi`. |
| Admin Settings UI | Four-section inner nav (`docs/FIXES_UI.md` §9.1, LOCKED); the workspace block is admin-only; `docs/FIXES_UI.md:109` forbids backup UI and `:1311` has an unchecked "No backup UI" box. | Added a **5th** nav item (deviation, 1.3). `docs/FIXES_UI.md` left untouched; the supersession is recorded in `HANDOFF.md` and `docs/RESUME_NEXT_SESSION.md`. |
| Startup / quit hooks | `startMainProcess`, `openLocalStore`, `closeLocalStore`, `installLifecycleListeners` (`before-quit`), a 60 s `localPurgeTimer` as the periodic-timer precedent, and the updater's `beforeQuitAndInstall` hook. | T1/T2/T3 wired into those exact seams. `updateInstallInProgress` was **declared but never set** — the before-quit guard was dead code; it is now set by the updater's pre-install hook. |
| Absence tests | `tests/backup-removal.test.ts` asserted backups were absent across 9 files; `tests/settings.test.tsx:21` asserted no "Backup Now"; `tests/sql-schema.test.ts:239` keeps `supabase/schema.sql` free of `dks-backups`/`storage.buckets`. | The removal suite was replaced by `tests/cloud-backup-security.test.ts` (boundaries, not absence). `settings.test.tsx` was scoped to the About section and given a positive assertion for the new nav item. `schema.sql` still passes untouched — backups are in R2, not Supabase Storage. |

### 1.3 Deviations (each deliberate)

1. **Branch** — see 1.1.
2. **Fingerprint strengthened.** The brief's digest (`entries` count + `max(updated_at)` + `max(id)`; `app_columns` count + `max(updated_at)`; `settings` `max(updated_at)`) does **not** move when two edits land in the same millisecond — a real, reproduced case. Added `SUM(version)` and `SUM(deleted)` for entries, `SUM(deleted)` for columns and `COUNT(*)` for settings. Still aggregate-only: no row content ever enters the fingerprint.
3. **No 5th migration** — backup state in `sync_meta` (see 1.2).
4. **8th IPC channel `dks:backup:set-session`** — required for main to authorise Worker calls; not admin-gated (an approved Office session must also back up), refuses `office-pending`, clears on `null`.
5. **5th Settings nav item** — conflicts with LOCKED `docs/FIXES_UI.md` §9.1 (four sections). Documented, not silently changed; the spec file was not edited.
6. **Retention cron shipped as dry-run** — the brief allowed "dry-run log only, or leave off; state which". It scans, logs and deletes nothing until `RETENTION_MODE=enforce` is set, which is a PR2 decision. The newest object is always protected.
7. **`tests/backup-removal.test.ts` deleted** — replaced by the boundary suite. `HANDOFF.md` warns against deleting absence tests blindly, so the replacement and the reason are recorded in `HANDOFF.md`, `docs/RESUME_NEXT_SESSION.md` §F4 and `ARENA/TO_DO_LIST.md` PKG-08.
8. **Edited `HANDOFF.md`, `docs/RESUME_NEXT_SESSION.md`, `ARENA/TO_DO_LIST.md`, `ARENA/ARENA_PROGRESS.md`** even though `ARENA/TO_DO_LIST.md:35` says those handoff/spec files are never edited. The brief explicitly required updating the guide ("no automatic backup is superseded; document the exception"), so every edit is a dated, signed-off supersession note rather than a rewrite. `docs/FIXES_UI.md` remains untouched.
9. **No new npm dependency** — `package.json` is frozen, so the Worker hand-rolls its R2/context types and verifies RS256 with WebCrypto instead of using `jose`/`@cloudflare/workers-types`.
10. **Table-name mapping** — brief names vs. real local names, see 1.2.

---

## 2. Architecture summary

```
Electron main (node)                         Cloudflare Worker                 Cloudflare R2
─────────────────────                        ─────────────────                 ─────────────
backup-scheduler.ts   T1 launch / T2 quit / T3 hourly, single flight
backup-snapshot.ts    better-sqlite3 backup() → VACUUM INTO fallback → drop excluded tables → VACUUM
backup-crypto.ts      AES-256-GCM, 96-bit IV, DKSBK1 envelope, AAD-bound metadata
backup-service.ts     pending queue, state in sync_meta, drill, history
backup-client.ts      fetch → Worker                            POST /v1/backups  →  put()
backup-ipc.ts         admin gate, 8 channels                    GET  /v1/backups  →  list()
electron/preload      validators + frozen bridge                GET  /v1/backups/{id} → get() stream
BackupRecoverySection.tsx  admin-only UI                        GET  /health, cron (dry-run)
                                                              auth.ts: JWKS (cached) + PostgREST role
                                                                                   + office_session_is_approved()
```

**Snapshot.** Taken only in main, never by copying the live file: `PASSIVE wal_checkpoint` →
`backup()` (falling back to `VACUUM INTO`) → open the copy → `DROP TABLE IF EXISTS` for
`outbox`, `sync_meta`, `error_report_queue`, `error_report_dedupe` → `VACUUM` → close.
Auth/session data never enters it (it lives in Electron session storage, not SQLite).
Included: `entries` (active **and** soft-deleted), `columns` (including deleted),
`local_settings`, `audit_log`, `notifications`, `conflicts`, `schema_migrations`.
`createSnapshot` re-opens the copy and runs `PRAGMA integrity_check` before returning it.

**Envelope.** `DKSBK1`(6) · version `0x01`(1) · IV(12) · GCM tag(16) · ciphertext — a
35-byte header. The authenticated additional data is `DKSBK1|1|{plaintextSha256}|{schemaVersion}`,
derived from the *final* metadata, so the published plaintext hash is itself authenticated.
Failure codes: `BAD_MAGIC`, `BAD_VERSION`, `TRUNCATED`, `BAD_METADATA`, `AUTH_FAILED`
(wrong key and tampering are deliberately indistinguishable), `CHECKSUM_MISMATCH`,
`KEY_UNAVAILABLE`, `KEY_INVALID`.

**Key handling.** 256 random bytes generated once, wrapped by `safeStorage` (DPAPI) at
`<userData>/backup-key.bin`, mode `0600`. Setup fails hard if `safeStorage` is unavailable;
the plaintext key is never persisted and only its SHA-256 is stored. The recovery key is the
same 32 bytes shown **once** in the wizard with a copy button and an "I have saved this"
checkbox plus a paste-back confirmation.

**Triggers.** T1 first launch of the Asia/Muscat day (fired from `setSession`, because the
JWT only exists once the renderer restores a session), T2 before quit inside an 8 s budget,
T3 hourly. One `BackupSingleFlight` lock: a second caller **joins** the in-flight run and
reports its result rather than inventing one. Persisted in `sync_meta`: `lastAttemptAt`,
`lastSuccessAt`, `lastSuccessDate`, `lastCheckedDate`, `lastFingerprint`, `lastOutcome`.
Unchanged fingerprint → no upload, event logged as "checked, no changes". A failed run
retries after 15 minutes instead of waiting for the next Muscat midnight. **Backups only
happen while DKS runs** — stated in the UI and in `HANDOFF.md`.

**Upload safety.** A snapshot is taken **only when the pending queue is empty** (found and
fixed by `tests/backup-offline-queue.test.ts`: stacking envelopes on an offline PC grew the
queue forever and kept publishing the oldest copy). A file is deleted only after the Worker
re-reads the stored object and returns a matching SHA-256 — so the newest verified snapshot
is never replaced by an unconfirmed one, and pending offline work is never lost silently.
Object keys are server-generated from the Worker's own clock in Asia/Muscat; the client's
key is never trusted.

**Worker trust model.** Verify the Supabase JWT from JWKS (RS256 only, HS256 refused,
10-minute cache, stale-on-error) → look the role up in PostgREST with the *user's* JWT and
the anon key (RLS self-row) → for Office sessions also require `office_session_is_approved()`.
No service-role key, no client-trusted role, no R2 credential in the app. Every route returns
`{error:{code,message}}` and never logs customer data, keys or tokens.

**PR2/PR3 interfaces (designed, not shipped).** `STEP_UP_REQUIRED` plus
`requireStepUp()` in `auth.ts` is the reserved email-OTP gate for destructive operations;
`retentionMode()`/`runRetention()` already compute what a delete pass would remove. No
`DELETE`/`PUT` route exists, and the UI's Recover and Delete buttons are rendered disabled
with the title "Coming in a later update".

---

## 3. Files changed by area

**Electron main — new (7):** `backup-types.ts` (151 L), `backup-crypto.ts` (330), `backup-snapshot.ts` (138),
`backup-scheduler.ts` (198), `backup-client.ts` (462), `backup-service.ts` (967), `backup-ipc.ts` (226).
**Electron main — modified (2):** `sqlite.ts` (`BASE_SCHEMA_STATEMENTS`, `SNAPSHOT_EXCLUDED_TABLES`,
`ensureBaseSchema()`, `computeBackupFingerprint()`, `getBackupRecordCounts()`, `createSnapshotCopy()`,
`getBackupMeta`/`setBackupMeta`, `getDatabasePath()`); `index.ts` (service creation in `openLocalStore`,
teardown in `closeLocalStore`, hourly timer, before-quit backup inside the budget, and
`updateInstallInProgress` now actually set by `flushSessionStorageBeforeInstall`).

**Preload:** `electron/preload/index.ts` — `BACKUP_CHANNELS`, `invokeBackup`, 4 validators,
frozen `backupApi`, exposed as `window.dks.backup`.

**Cloudflare Worker — new:** `cloudflare-backup/src/auth.ts` (420 L), `src/routes.ts` (507),
`src/index.ts` (181), `wrangler.toml` (38), `README.md` (106).

**Renderer:** new `src/features/settings/BackupRecoverySection.tsx` (752 L); modified
`SettingsPage.tsx` (5th nav item, `backup` prop), `settings.css` (`.settings-backup*`, design
tokens only, dark-theme safe, 720 px breakpoint), `src/lib/types.ts` (`DksBackupApi` + 7 types),
`src/renderer/App.tsx` (pushes the session credential to main).

**Tests — new (9, 141 tests):** `backup-envelope.test.ts` (14), `backup-snapshot.test.ts` (11),
`backup-triggers.test.ts` (16), `backup-offline-queue.test.ts` (11), `backup-ipc.test.ts` (13),
`backup-worker.test.ts` (31), `backup-settings-ui.test.tsx` (23), `cloud-backup-security.test.ts` (16),
`backup-client-contract.test.ts` (5).
**Tests — modified:** `settings.test.tsx` (scoped + positive nav assertion).

**Fixed during the safety review of 2026-10-31** (see `CLOUD_BACKUP_PR1_SAFETY_REVIEW.md`):
the record-count header now uses the Worker's `k=v;k=v` format on both sides, and a confirmed
upload records the fingerprint of the snapshot that was *actually* uploaded rather than the
current database state (a stale queued snapshot could otherwise make newer data look backed up).
**Tests — removed:** `backup-removal.test.ts` (superseded).

**Docs:** `HANDOFF.md` §Privacy and file handling (dated supersession + exception limits),
`docs/RESUME_NEXT_SESSION.md` §2 and §F4, `ARENA/TO_DO_LIST.md` (PKG-08 superseded; CBKP-01..03 added),
`ARENA/ARENA_PROGRESS.md` (F4 note, constraints line). `docs/FIXES_UI.md` untouched.

---

## 4. Owner setup steps (exact)

Prerequisites: Node 20.19 (`.nvmrc`), a Cloudflare account, `npm i -g wrangler`.

```bash
cd cloudflare-backup
wrangler login                                  # browser OAuth for your Cloudflare account
wrangler r2 bucket create dks-backups           # once per account; PRIVATE — do not enable public access
wrangler secret put SUPABASE_URL                # e.g. https://<project>.supabase.co
wrangler secret put SUPABASE_ANON_KEY           # the anon/public key only — never the service-role key
wrangler deploy                                 # prints https://dks-backup.<account>.workers.dev
```

Optional checks:

```bash
curl https://dks-backup.<account>.workers.dev/health     # {"ok":true,"r2":true,...}
wrangler secret put RETENTION_MODE                       # only to turn deletes on: value "enforce" (PR2)
```

Then, in the installed DKS app as an **administrator**:

1. Settings → **Backup & Recovery** → paste the Worker URL into *Backup service address* → **Save address**.
   The status card should move from "Not checked yet" to "Connected".
2. **Recovery key** → *Create recovery key* → copy the key somewhere offline → tick
   **"I have saved this recovery key"** → paste it back → **Confirm recovery key**.
   Without this key no backup can ever be opened again; DKS keeps only its SHA-256.
3. **Test restore** → it downloads the newest verified backup, decrypts it, checks the GCM tag,
   the plaintext SHA-256 and `PRAGMA integrity_check`, then deletes the temp files. It never
   touches live data. Expect "The latest backup downloaded, decrypted and passed the integrity check".
4. Leave the toggle **On**. Backups then run at the first launch of each Muscat day, hourly
   while DKS stays open, and once before it closes.
5. Confirm the Worker's R2 bucket stays private: no R2.dev subdomain, no public ACL, no
   custom public domain.

---

## 5. Security checklist with evidence

| Requirement | Status | Evidence |
| --- | --- | --- |
| No R2 secret in the `.exe` | Met | `grep -rniE "R2_ACCESS\|R2_SECRET\|AWS_ACCESS" electron/ src/ cloudflare-backup/` → no hits. The Worker holds the binding; the app only ever talks HTTPS to the Worker URL the admin pastes in. |
| No service-role key | Met | Only hits are `src/lib/sync-error.ts` (which **redacts** the string) and a comment in `wrangler.toml:38`. Role lookup uses the user's JWT + anon key against PostgREST (RLS self-row). |
| No client-trusted roles | Met | `cloudflare-backup/src/auth.ts` verifies the JWT signature against Supabase JWKS and re-reads `profiles.role`; `backup-ipc.ts` additionally refuses any session role that is not `admin` (`tests/backup-ipc.test.ts`). |
| No public bucket | Met | `wrangler.toml` documents "The bucket is PRIVATE. Never enable public access"; `tests/cloud-backup-security.test.ts` asserts it. No bucket policy is added to `supabase/schema.sql` (backups are in R2, not Supabase Storage). |
| No Google OAuth | Met | Auth is Supabase-only; no new provider, no new dependency. |
| Newest verified snapshot never overwritten | Met | Keys are unique per upload (`{hhmmss}-{shortid}`), and `flushPendingQueue` only deletes a local file after `verifyStored()` returns a matching SHA-256 (`tests/backup-offline-queue.test.ts` covers the mismatch case). |
| Pending offline changes never lost silently | Met | Queue in `%APPDATA%\DKS\backups\pending`; checksum mismatch and network failure both keep the file; the UI shows "Waiting to upload: N file(s)" and the last error. |
| Visa entry and sync never blocked | Met | Backup work is off the UI thread, bounded (8 s quit budget, 10 s drain), and a failure only produces a `pending`/`failed` event. |
| Snapshot never copies the live file | Met | `better-sqlite3` `backup()` with a `VACUUM INTO` fallback (`backup-snapshot.ts`); `tests/backup-snapshot.test.ts` builds a 1,200-row DB and checks `PRAGMA integrity_check = ok`. |
| Plaintext key never stored | Met | `safeStorage`-wrapped blob, mode `0600`, only SHA-256 of the key persisted; setup fails when `safeStorage` is unavailable (`KEY_UNAVAILABLE`). |
| Renderer has no Node/crypto/file/Worker access | Met | `contextIsolation` unchanged; the bridge is a frozen object of 8 methods; `tests/cloud-backup-security.test.ts` asserts no `node:`/`electron/`/`fetch`/`XMLHttpRequest` in `BackupRecoverySection.tsx`. |
| Never log customer data, keys or tokens | Met | Worker logs are counters and object keys only; the app logs outcomes, not payloads; `sync-error.ts` redaction still applies. |
| Destructive ops need step-up | Designed, not enabled | `STEP_UP_REQUIRED` + `requireStepUp()` in `auth.ts`; no `DELETE`/`PUT` route exists; retention is dry-run. |
| Admin enforcement in main | Met | `requireAdmin()` runs before every admin channel; `office-pending` is refused outright (`tests/backup-ipc.test.ts`, 13 tests). |

---

## 6. Tests run, results, and what is still unverified

### Ran here (sandbox, Linux, Node 22)

| Command | Result |
| --- | --- |
| `npx vitest run` (full suite) | **113 files, 1157 passed, 3 skipped, 0 failed** (246 s). Baseline before this work: 103 files, 984 passed, 3 skipped. Counts after the blocker fixes in §7. |
| `npm run typecheck` (`tsconfig.json` + `tsconfig.node.json`) | Clean, 0 errors. |
| `npm run build` (`build:renderer` + `build:electron`) | Built successfully (pre-existing >500 kB chunk warning for `SheetPage`). |

New coverage: envelope round-trip, wrong-key and corruption rejection, tamper detection,
fingerprint determinism and change detection, snapshot table exclusion + integrity + table
recreation, trigger logic under fake timers (T1/T2/T3, single flight, catch-up, retry after
failure), offline-queue retention and checksum-confirmed deletion, object-key safety, Worker
handlers with a real WebCrypto RS256 key pair (foreign-key, expired, HS256 and no-`sub` tokens
rejected; JWKS cached across verifies), PostgREST role lookup, `office_session_is_approved`
gate, upload/list/get/health handlers against a fake R2, retention dry-run → enforce, IPC
admin enforcement, preload validation, and the Settings UI's loading/empty/error/disabled states.
No real customer data in any fixture — every row is generated.

### NOT verified — needs live Cloudflare/Supabase or a real Windows PC

Nothing below has been exercised against real infrastructure; treat the cloud path as
**unproven until the owner deploys**:

- JWKS verification against real Supabase tokens (key rotation, `kid` changes, clock skew).
- PostgREST role lookup and `office_session_is_approved()` as called from a Worker.
- Real R2 `put`/`head`/`list` cursor pagination and streamed `get`, including the 200 MB limit.
- The cron actually firing on Cloudflare, and dry-run log volume.
- `safeStorage`/DPAPI on Windows, and `better-sqlite3` `backup()`/`VACUUM INTO` inside the
  **packaged Electron ABI** (this sandbox ran a Node-22 build of the module).
- The before-quit path against a real NSIS `quitAndInstall`, and the offline queue surviving a
  real reboot or a lost network.
- The test-restore drill against a real downloaded backup.
- The Settings section in both themes at real window sizes, and keyboard navigation on a real PC.

### Suggested first live checks

`curl <worker>/health` → `{"ok":true,"r2":true}`; one **Back up now** from the app; confirm the
object appears in the R2 console with a `backups/YYYY/MM/...` key; open the month in Settings →
Backup & Recovery and expect one "Verified" row; then **Test restore** and expect
"The latest backup downloaded, decrypted and passed the integrity check".

## 7. Blocker fixes (round 2 — before commit)

Three issues were raised on the first pass. All three are fixed, and each one
below names the test that pins it.

### 7.1 Streaming upload with a real size limit

`handleUpload` (`cloudflare-backup/src/routes.ts`) no longer calls
`request.arrayBuffer()`. A Worker isolate has **128 MB of memory on every plan
and that cannot be raised**, so buffering a 200 MB upload was never going to
work. The upload is now streamed:

1. `readHead()` reads only the first **7 bytes** (magic + version) to reject
   anything that is not a DKS envelope. Nothing else is buffered up front.
2. `streamFromHead()` replays those bytes and continues from the same reader, so
   no byte is lost or duplicated at the seam.
3. `createUploadByteCounter()` is a `TransformStream` that counts bytes as they
   pass and **throws the moment the total exceeds `MAX_UPLOAD_BYTES` (200 MB)**.
   The put rejects, the Worker answers `413 PAYLOAD_TOO_LARGE`, and **no object
   is written**.
4. A `content-length` over the limit is still refused immediately, but the limit
   does not depend on it: a client can omit the header and the stream is still
   capped.

Peak Worker memory is one chunk, not the payload. A stream that dies mid-upload
becomes `502 UNAVAILABLE` in the standard `{error:{code,message}}` shape; a
stream that dies before the header arrives becomes a clean `400`.

**Checksum provenance, stated plainly:** a Worker cannot compute a SHA-256 over
a body it never holds (`crypto.subtle.digest` needs the whole buffer). The
stored `ciphertextSha256` is therefore the one the **desktop app declared**, and
R2 records it with `ciphertextSha256Source: client-declared`. HEAD/GET echo it
back with `x-dks-ciphertext-sha256-source: client-declared`, and the desktop app
re-hashes the bytes it downloads and compares (`testDrill` → stage `checksum`).
Real integrity still comes from the AES-GCM tag and the AAD-bound plaintext
SHA-256 at decrypt time. Nothing in the code or the UI claims a server-side hash.

Tests: `tests/backup-worker.test.ts` — *"stores a below-limit streamed upload
byte for byte"* (64 KB over 16 chunks), *"returns 413 when the streamed body
exceeds the limit"*, *"writes no object at all when the upload exceeds the
limit"*, *"keeps the predictable JSON error shape when the stream breaks
mid-upload"*, *"reports a clean 400 when the stream dies before the header
arrives"*, *"requires a declared encrypted checksum and refuses to guess one"*.
The fake R2 in that file now consumes `ReadableStream` puts.

### 7.2 `keyId` and a real recovery-key import

**`keyId`** = the first 12 bytes of `SHA-256(key)`, hex (24 chars). It is a hash
prefix, never a key. It is now required in `BackupMetadata` and is part of the
AES-GCM **AAD** (`DKSBK1|1|<plaintextSha256>|<schemaVersion>|<keyId>`), so an
envelope cannot be relabelled to another key without breaking authentication. It
travels on upload (`x-dks-key-id`), is stored in R2 custom metadata, is echoed on
HEAD/GET, appears in list rows, in `BackupState`, in history and in the Settings
status grid. Consequence, accepted: **envelopes written before this change no
longer decrypt.** There are no deployed backups, so nothing is lost.

**Import** (`BackupService.setupKeyImport(recoveryKey, expectedKeyId?)`) is the
replacement-PC path, exposed through IPC (`action: 'import'`), preload, the
renderer bridge and Settings → Backup & Recovery → *"Open backups made on
another PC"*. It parses and validates the key, optionally checks it against a
requested `keyId`, **refuses to replace a different key already on this PC**,
wraps the key with `safeStorage`, writes `<userData>/backup-key.bin` mode 0600,
stores only `dks.backup.keyHash`, and **fails closed with no plaintext fallback**
when `safeStorage` is unavailable. The drill names a key mismatch explicitly
(`"This backup was encrypted with key …; the key available here is …"`) instead
of a generic decryption failure.

Tests: `tests/backup-key-import.test.ts` (10) — import opens a backup made with
another PC's key end to end through the drill; invalid keys refused; key-id
mismatch refused; a different key on this PC refused; wrong key fails at
`decrypt` with both ids in the message and **without touching live data**
(40 rows still readable); no plaintext key in any SQLite table (dumped with
`better-sqlite3` and scanned), in any file under `userDataPath` (utf8 + base64),
or in any log line; `safeStorage` unavailable → no key file at all.
`tests/backup-envelope.test.ts` adds key-id stability/uniqueness and the
AAD-binding check.

### 7.3 Authoritative vs local cache

PR1 backs up **this PC's local SQLite cache**. Supabase remains the system of
record, so the honest answer is: **not authoritative**. That is now stated in
the data and in the UI rather than left to inference:

- `source: 'local-cache'` is a **required** field of `BackupMetadata`
  (`isBackupMetadata` rejects anything else, including `'authoritative'`), is in
  the AAD, and is carried through state, history, list rows, R2 metadata and the
  upload headers. An object with no recorded source is reported as `null`, not
  guessed.
- Settings shows *"A backup is an encrypted copy of this PC's local cache…
  Supabase stays the system of record"*, plus a *"What a backup holds"* status
  cell. The last-success text reads "Uploaded and verified (local cache
  snapshot)".
- **Completeness of the cache itself was the real gap**: `selectTable()`
  (`src/features/sync/supabase-sync.ts`) did one unpaginated `select('*')`, so
  PostgREST's `db-max-rows` (1000 by default) silently capped the cache — and
  therefore every snapshot taken from it. It now walks `order('id').range()`
  pages of 500 until a short page arrives, with a 100 000-row hard stop, and it
  reports a page failure instead of returning a partial cache. Clients without
  `range` support still work, one shot.
- A **pending outbox blocks the backup**: the run ends `incomplete`, takes no
  snapshot, uploads nothing, records no success and retries in 5 minutes. No run
  can record a successful complete backup while completeness is unproven.
- **Cloud backup now ships off** (`DEFAULT_STATE.enabled = false`). Nothing
  leaves a PC because DKS was installed; an administrator turns it on.

Tests: `tests/backup-cache-completeness.test.ts` (8) — 2 340 rows pulled past a
1 000-row server cap with the exact page ranges asserted, short-page stop, empty
table, non-chainable client fallback, page failure surfaced, runaway cursor
stopped, and the `source`/`keyId` metadata rules. `tests/backup-offline-queue.test.ts`
adds *"attaches the key id and the local-cache label to every upload"* and *"is
off until an administrator turns it on"*. `tests/backup-worker.test.ts` adds
key-id/source on list rows and the honest `null` for older objects.
`tests/backup-settings-ui.test.tsx` adds the local-cache wording, the import
flow, its refusal path, and hiding import while a new key is on screen.

### 7.4 Files changed in this round

| File | Change |
| --- | --- |
| `cloudflare-backup/src/routes.ts` | Streaming upload, byte counter, 413/400/502 paths, `keyId`/`source`/client-declared checksum metadata, list rows, HEAD/GET headers |
| `cloudflare-backup/src/index.ts` | CORS header list includes the new `x-dks-*` headers |
| `electron/main/backup-crypto.ts` | `keyId` in metadata + AAD, `keyIdFromKey`/`keyIdFromStoredHash`/`isKeyId`, `source` required |
| `electron/main/backup-client.ts` | Upload sends declared checksum + key id + source; `listMetadataFor`/`list` return them; `verifyStored` docblock states the provenance |
| `electron/main/backup-service.ts` | `currentKeyId()`, `setupKeyImport()`, drill checksum + key-mismatch stages, `source` everywhere, default off |
| `electron/main/backup-types.ts` | `keyId`/`source` on state, events, history and setup result |
| `electron/main/backup-ipc.ts` | `action: 'import'` |
| `electron/preload/index.ts` | Import allowed; `keyId` validated as 24-hex |
| `src/lib/types.ts` | Renderer types for import, key id and source |
| `src/features/settings/BackupRecoverySection.tsx` | Import UI, key-id display, local-cache statement |
| `src/features/settings/settings.css` | Styles for the new blocks (design tokens only) |
| `src/features/sync/supabase-sync.ts` | Paginated `selectTable()` |
| `tests/backup-key-import.test.ts` | New (10) |
| `tests/backup-cache-completeness.test.ts` | New (8) |
| `tests/backup-worker.test.ts` | Streaming fakes + 8 new tests (38 total) |
| `tests/backup-offline-queue.test.ts` | Header capture, default-off test (14 total) |
| `tests/backup-envelope.test.ts` | Key-id tests (16 total) |
| `tests/backup-settings-ui.test.tsx` | Import + labelling tests (27 total) |
| `tests/backup-client-contract.test.ts` | Header/key-id assertions (5 total) |

### 7.5 Still unverified live (unchanged, plus two)

Everything in §6's "NOT verified" list still stands. Two additions from this
round:

- The streaming path has only been exercised against a fake R2 that consumes
  `ReadableStream`. Real R2 behaviour on a rejected stream (partial-object
  cleanup, error surfaced to the client) is unproven, as is the 200 MB limit
  against a real multipart upload.
- `setupKeyImport` has only been exercised against an in-memory `safeStorage`
  stand-in. Windows DPAPI wrapping of an imported key is untested.

## 8. v1 policy corrections (round 3 — owner-approved policy)

Six corrections, all implemented in the working tree and covered by tests.
Full-suite result after them: **115 files, 1207 passed, 3 skipped, 0 failed**.

### 8.1 Backup is Admin-only

| Operation | Electron IPC | Cloudflare Worker |
| --- | --- | --- |
| Upload (`POST /v1/backups`) | Admin only (`setSession` refuses any non-admin credential, so the scheduler has nothing to run with) | `requireBackupAdmin` → **Admin only**; an Office session gets `403 OFFICE_NOT_ALLOWED` whether or not its sign-in approval is valid |
| List / download / drill / key setup / key import / configure / state | `requireAdmin` on all 8 admin channels (payload role, reported session role, and `office-pending` clearance all checked) | `requireAdmin` → `requireBackupAdmin` (Admin only) |
| Session push | Admin only; `null` (sign-out) always allowed | n/a |
| Settings tab | `visibleSettingsSections(role)` removes "Backup & recovery" for any non-admin role | n/a |

`requireAdminOrApprovedOffice` was **deleted**, not left as dead code. Trust
order is unchanged: RS256 signature over the exact received bytes → exp/nbf/sub
→ **iss/aud** → PostgREST `profiles.role` lookup with the caller's own token
under RLS. `app_metadata` and any body/header role are never read; a request
carrying `role: admin` / `x-dks-role: admin` from a non-admin subject is refused
(tested).

### 8.2 One designated Admin backup PC, enforced server-side

- **Device identity:** `BackupService.deviceId()` generates 16 random bytes
  (`randomBytes(16).toString('hex')`) once and stores it in `sync_meta`
  (`dks.backup.deviceId`). Never hostname, user name, MAC, serial or email.
  `sync_meta` is in `SNAPSHOT_EXCLUDED_TABLES`, so the id never enters a backup.
  The label defaults to `DKS-<first 6 hex>` and is administrator-editable.
- **Shared designation:** `public.settings` row
  `dks.backup.designated_device = {deviceId, label, designatedAt}`. RLS on that
  table makes INSERT/UPDATE/DELETE **Admin-only**, so the row is authoritative.
  Written by the renderer (`src/features/settings/backup-designation.ts`) from
  the "Make this PC the backup PC" confirmation.
- **Server enforcement:** `handleUpload` calls `requireDesignatedDevice()`,
  which reads `x-dks-device-id` and re-reads the settings row with the
  uploader's own JWT on every upload. Mismatch or no designation →
  `403 DEVICE_NOT_DESIGNATED`; unreadable row → fail closed. The local copy in
  main is only a scheduling hint.
- **Behaviour:** the designated PC runs T1/T2/T3. Any other Admin PC gets
  `no_changes` — "Automatic backup runs on another designated Admin PC" — and
  cannot force one either: `runNow('manual')` returns "Back up now is only
  available on the designated backup PC" and the UI hides the button. List,
  download, key import and test-restore stay available from any Admin PC. No
  implicit takeover: the row has to change.

### 8.3 Upload limit

`MAX_UPLOAD_BYTES = 25 * 1024 * 1024`. Both guards kept: the `content-length`
early refusal and the counting `TransformStream`. A real snapshot is ~65 KB at
~1,200 rows, so this is ~380x headroom that still trips on a corrupt or
runaway snapshot.

### 8.4 Completeness — never a silent partial cache

Three conditions must hold before a snapshot is taken:

1. the local outbox is empty (pre-existing);
2. a **full authorized pull/reconcile completed** — reported by the renderer's
   sync engine over the existing `dks:local:set-sync-status` channel as
   `lastPullAt` + `lastPullComplete` + `lastPullRows`;
3. no local mutation happened after that pull — `enqueueOutbox()` (the single
   funnel for local mutations) stamps `lastLocalMutationAt`, compared against
   `lastPullAt`.

`lastPullComplete` is true only when the paginated walk reached a short page for
**both** `entries` and `app_columns`, and it is recorded only when the whole
sync run finished healthy. If any condition fails, the run ends `incomplete`
with the specific reason, records no success, and retries in 5 minutes.
`source` stays `local-cache`; the UI wording is now "Encrypted snapshot of the
designated Admin PC's synchronised local workspace… Supabase remains the live
authority… disaster-recovery copy, not an authoritative backup".
No Supabase logic moved into main: the coordination path is the existing typed
sync-state channel, extended with four optional fields.

### 8.5 Pagination proven safe under RLS

`tests/sync-pagination-rls.test.ts` (13 tests) drives a PostgREST-faithful
double (1000-row response cap, `range()` narrowing **after** the RLS policy):
Admin walks 1,200 rows over 3 pages with a stable `order('id')` and no
duplicates; Office sees only rows inside its visibility window on every page and
never a row outside it; a failed later page throws instead of returning a
partial cache; both `entries` and `app_columns` are walked; a runaway cursor
stops at 100,000 rows. `runSupabaseSync` reports `lastPullComplete` for a
paginated client and refuses to claim it for one that cannot paginate. The
existing `office-3-day-window-postgres`, `entry-visibility-postgres` and
`entries-rls` suites stay green.

### 8.6 JWT hardening

- `iss` must equal `${SUPABASE_URL}/auth/v1` exactly (`expectedIssuer`).
- `aud` must be `authenticated` — Supabase's audience for a signed-in user's
  access token — or an array containing it. Overridable only via the optional
  `SUPABASE_JWT_AUDIENCE` var; `service_role` and `anon` are refused.
- An unknown `kid` triggers exactly **one** forced JWKS refresh before
  rejection; the normal 10-minute cache is unchanged and there is no loop.
- Signature/exp/nbf/sub validation is untouched, and HS256 and foreign-key
  tokens are still refused.
