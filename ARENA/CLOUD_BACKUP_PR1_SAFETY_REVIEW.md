# Cloud backup PR1 — safety review

Reviewed 2026-10-31 against the working tree on branch `arena/38587425-dks` (uncommitted, nothing
pushed, merged, tagged or deployed). Every statement below names the file and function it came
from. No Cloudflare or Supabase command was run; no account was touched.

**Two defects found by this review were fixed in the same turn**, because both were small and
provable, and one regression test was added:

1. **Record counts were silently lost on every upload.** `electron/main/backup-client.ts` sent
   `x-dks-record-counts: JSON.stringify(...)` while the Worker decodes `k=v;k=v`
   (`cloudflare-backup/src/routes.ts:129 decodeRecordCounts`). Proved: feeding the old JSON value
   to the Worker's decoder returns `{}`. Fixed by adding the Worker's codec to the client and a
   contract test (`tests/backup-client-contract.test.ts`, 5 tests) that decodes the client's real
   header with the Worker's real function.
2. **A stale queued snapshot could make newer data look backed up.** `runInternal` wrote
   `lastFingerprint = <current database fingerprint>` after confirming an upload — even when the
   object uploaded was an *older* queued snapshot. The next trigger would then see "no changes"
   and skip the newer data. Fixed: `flushPendingQueue` now returns the fingerprint of the snapshot
   it actually uploaded (`electron/main/backup-service.ts`), and `runInternal` records that one.
   Regression test: `tests/backup-offline-queue.test.ts` › "never lets a stale queued snapshot make
   newer data look backed up" — verified to **fail** against the old line and pass against the fix.

Full suite after those changes: **111 files, 1124 passed, 3 skipped, 0 failed**; `npm run typecheck`
and `npm run build` clean.

### Round 2 — the three blockers raised on this review are fixed

Four of the ranked risks in §7 (1, 3, 4, 5) were the blockers, and they are now
closed in the working tree. Each keeps its original number below and is marked
**FIXED (round 2)** with the change and the test that pins it. Full details are
in §7 of `ARENA/CLOUD_BACKUP_PR1_REPORT.md`.

| Blocker | Resolution | Test |
| --- | --- | --- |
| Buffered upload, unachievable 200 MB limit | `handleUpload` streams: 7-byte envelope probe → `TransformStream` byte counter → `R2.put`. Over the cap ⇒ `413`, **no object written**. Mid-stream failure ⇒ `502` in the standard error shape. Peak memory is one chunk | `tests/backup-worker.test.ts` (6 new) |
| No server-computed checksum claimed | The stored `ciphertextSha256` is the **client-declared** one, recorded as `ciphertextSha256Source: client-declared`, echoed on HEAD/GET, and re-verified by hashing the downloaded bytes in `testDrill` | worker + offline-queue + key-import drills |
| No key id in metadata | `keyId` (12-byte SHA-256 prefix) is required, AAD-bound, and carried through R2 metadata, list rows, state, history and the UI | `tests/backup-envelope.test.ts`, `tests/backup-key-import.test.ts` |
| No recovery-key import | `setupKeyImport()` + IPC/preload/Settings path; refuses a conflicting key; fails closed without `safeStorage`; no plaintext at rest | `tests/backup-key-import.test.ts` (10) |
| Unpaginated cache pull | `selectTable()` walks `order('id').range()` pages of 500 with a 100 000-row stop | `tests/backup-cache-completeness.test.ts` (8) |
| Cloud backup on by default | `DEFAULT_STATE.enabled = false` — an administrator turns it on | `tests/backup-offline-queue.test.ts` |

Full suite after the round-2 changes: **113 files, 1157 passed, 3 skipped,
0 failed** (246 s); `npm run typecheck` and `npm run build` clean.

### Round 3 — owner-approved v1 policy

Six corrections followed from the owner's review of this document. Details and
the test names are in §8 of `ARENA/CLOUD_BACKUP_PR1_REPORT.md`; the items below
supersede the corresponding findings here.

1. **Upload is now Admin-only.** `handleUpload` uses `requireBackupAdmin`;
   `requireAdminOrApprovedOffice` was deleted. An Office session is refused with
   `403 OFFICE_NOT_ALLOWED` even when its sign-in approval is valid, and the
   Electron side refuses an Office credential outright. §3's description of the
   Office upload path no longer applies.
2. **One designated Admin backup PC, enforced by the Worker** against
   `public.settings` → `dks.backup.designated_device` on every upload
   (`403 DEVICE_NOT_DESIGNATED`). The §4 "Multi-PC caveat" is now a control, not
   an operational note: a second Admin PC cannot start a parallel lineage.
3. **`MAX_UPLOAD_BYTES` is 25 MB**, not 200 MB — ~380x the observed snapshot
   size, so it is a real tripwire.
4. **Completeness is now evidenced, not assumed.** Backup requires an empty
   outbox, a completed full authorized pull that walked every page, and no local
   mutation after it; otherwise the run is `incomplete` with a specific reason.
   §1's "Evidence that justifies calling a snapshot complete" gains a fifth
   item: the sync engine's own completeness report.
5. **The pagination change is proven safe under RLS** for both roles
   (`tests/sync-pagination-rls.test.ts`), including that a failed page throws
   rather than yielding a partial cache.
6. **JWT issuer and audience are now validated exactly**, and an unknown `kid`
   refreshes the JWKS once. §7 risk 6 is closed except for the `kid`-reuse
   note, which the single forced refresh bounds rather than eliminates.

Full suite after round 3: **115 files, 1207 passed, 3 skipped, 0 failed**;
`npm run typecheck` and `npm run build` clean.

---

## 1. Scope and completeness

### What is backed up

**The local SQLite cache only — not Supabase.** Supabase remains the cloud authority; PR1 does not
read from or write to Postgres on the desktop side at all.

- Source file: `dks-cache.sqlite`, opened by `SqliteStore` (`electron/main/sqlite.ts`).
- The snapshot is a byte-consistent copy of that database:
  `SqliteStore.createSnapshotCopy()` (sqlite.ts:2492) → `wal_checkpoint(PASSIVE)` →
  `better-sqlite3 backup()`, falling back to `VACUUM INTO` → open the copy → `DROP TABLE IF EXISTS`
  for `SNAPSHOT_EXCLUDED_TABLES` → `VACUUM` → close. The live file is never copied or modified.
- Excluded (snapshot copy only): `outbox`, `sync_meta`, `error_report_queue`, `error_report_dedupe`
  (`SNAPSHOT_EXCLUDED_TABLES`, sqlite.ts:517). Auth/session data is not in SQLite at all — it lives
  in Chromium session storage — so there is no auth table to exclude.
- Included: `entries` (active **and** soft-deleted), `columns` (including deleted definitions),
  `local_settings`, `audit_log`, `notifications`, `conflicts`, `schema_migrations`.
- `BASE_SCHEMA_STATEMENTS` (sqlite.ts:502) re-runs the CREATE-only migrations on **every** open, so
  a copy with those tables dropped still opens as a working database. Verified by
  `tests/backup-snapshot.test.ts:155` ("recreates the dropped tables when the copy is opened as a
  live database").

### Pagination, soft deletes, dynamic columns, settings

- **Pagination: not involved in making the backup.** The snapshot copies the database file; it never
  pages through rows. It *is* involved one level up — see the open risk in §7.5: the renderer's pull
  is `client.from(table).select('*')` with no `.range()` (`src/features/sync/supabase-sync.ts:525`),
  so the cache itself is only as complete as that single unpaginated read.
- **Soft-deleted rows: included.** They are ordinary rows in `entries` with `deleted = 1`; the copy
  keeps every row. Asserted at `tests/backup-snapshot.test.ts:96` (1,200 rows seeded, one of them
  soft-deleted: `listEntries(true)` = 1200 vs `listEntries()` = 1199).
- **Dynamic column definitions: included** (`columns` table), and covered by the fingerprint
  (`columnsCount`, `columnsMaxUpdatedAt`, `columnsDeletedSum` — `computeBackupFingerprint`).
- **Settings: included** (`local_settings`), fingerprinted by `settingsCount` + `settingsMaxUpdatedAt`.
- **Change detection:** `fingerprintDigest()` (backup-snapshot.ts:28) hashes ten aggregates only —
  counts, maxima and sums. No row content ever enters the fingerprint.

### Concurrent cloud changes

Not coordinated, by design. There is no cross-PC lock and no signalling:

- The snapshot is a point-in-time copy of *this* PC's cache. A change made in the cloud by another
  PC reaches this backup only after this PC's sync pulls it (`supabase-sync.ts:906-908`).
- Within this PC there is no external writer: the renderer never opens SQLite; every write goes
  through main-process IPC, and `backup()` is safe against concurrent WAL writers in-process.

### Pending offline writes

- **This PC:** `waitForOutboxDrain()` polls the outbox for up to `OUTBOX_DRAIN_TIMEOUT_MS` (10 s).
  If `hasUnpushedLocalChanges()` is still true — pending, processing **or failed** — the run stops
  with outcome `incomplete`, detail `snapshot incomplete: pending local changes`, and no snapshot is
  taken. Failed items are deliberately counted so a stuck sync is never photographed around.
- **Another PC:** its unpushed writes are invisible here. Its own outbox is excluded from snapshots
  anyway. Nothing in PR1 attempts to reconcile them.

### Evidence that justifies calling a snapshot complete

What is actually verified, in order:

1. `verifySnapshotFile()` (backup-snapshot.ts:103) re-opens the copy read-only and requires
   `PRAGMA integrity_check = ok` **and** zero surviving excluded tables, *before* encryption.
2. The envelope binds the plaintext SHA-256 into the AES-GCM AAD (`encryptBackup`), so a tampered or
   truncated file fails decryption rather than decrypting wrongly.
3. Upload is confirmed by re-reading the stored object: `BackupApiClient.verifyStored()` compares
   the `x-dks-ciphertext-sha256` recorded with the object against a hash the **desktop app** computed
   over the bytes it sent. The local file is deleted **only** after that match.
   **The Worker does not compute that checksum and does not claim to**: it streams the body straight
   into R2 (128 MB isolate limit, §7 risk 1) and a Worker has no streaming digest, so the value is
   the client-declared one, stored as `ciphertextSha256Source: client-declared`. The match still
   proves the bytes that came back from storage are the bytes that went in — which is what protects
   against truncation or corruption in transit and at rest — but it is not independent server-side
   evidence. The independent guarantee is the AES-GCM tag plus the AAD-bound plaintext SHA-256, both
   checked again by the test-restore drill, which now also re-hashes the download (`testDrill` →
   stage `checksum`) and names a key-id mismatch before attempting decryption.
4. `getBackupRecordCounts()` and the fingerprint are stored as object metadata, so each backup
   states its own row counts, alongside `keyId` and `source: 'local-cache'`.

What that does **not** prove: that the local cache contained everything in Supabase. A snapshot is
complete with respect to the cache. Round 2 closed the sharpest part of that gap — `selectTable()`
was an unpaginated `select('*')`, so PostgREST's `db-max-rows` (1000 by default) silently capped the
cache; it now walks pages until a short one — but the honest label is still **local cache, not an
authoritative copy**, and that is what `source`, the UI wording and the last-success text say.

---

## 2. Offline queue

State: `%APPDATA%\DKS\backups\pending\*.sqlite.enc` plus a `.meta.json` sidecar per envelope, both
written with mode `0600` (`writePending`, backup-service.ts:677). Listing is
`listPendingFiles()`, sorted oldest-first.

### Step-by-step: older snapshot pending, data changes offline, then reconnect

1. **Offline run.** `runInternal` finds the queue empty → takes snapshot **A**, encrypts it, writes
   `A.sqlite.enc` + `A.meta.json` (fingerprint **F1**). `flushPendingQueue()` fails (no network) →
   outcome `pending`, `lastSuccessAt` unchanged, UI shows "Waiting to upload: 1 file(s)".
2. **Data changes offline.** Fingerprint becomes **F2**.
3. **Next run, still offline.** The queue is **not** empty, so **no second snapshot is taken** — the
   run just tries to flush A again. (This is the fix from the previous session; before it, every
   offline run stacked another envelope and oldest-first upload kept publishing the stalest copy.)
4. **Reconnect, run.** Queue non-empty → still no new snapshot → A uploads → the Worker re-reads it →
   SHA-256 matches → **A and A.meta.json are deleted** → outcome `verified`.
5. **The confirmation records F1, not F2** (`lastFingerprint = upload.fingerprint`). This is the
   fix made during this review.
6. **Next run (even the same day).** `shouldRunTrigger` sees `lastFingerprint (F1) !== F2` →
   `data_changed` → queue is empty now → snapshot **B** (current data) → upload → verified,
   `lastFingerprint = F2`.
7. **Run after that.** Fingerprints match and today was checked → `no_changes`, nothing uploaded.

### Can "last successful backup" refer to stale data?

It can, and now says so truthfully rather than silently:

- `lastSuccessAt` / `lastSuccessDate` is the moment an upload was **confirmed**, not the moment the
  data was captured. If a day-old queued snapshot confirms today, the card reads today.
- Between steps 4 and 6 above, the newest confirmed backup does **not** contain the newest data. The
  difference is visible, though: `lastFingerprint` still differs from the live fingerprint, the
  history shows the older day, and the next trigger uploads B immediately.
- Before the fix, that window never closed on its own — the state claimed F2 was backed up when only
  F1 was. That is the defect the regression test now guards.

---

## 3. Authorization

The cloud boundary is the Worker. The renderer-reported role and the main-process IPC checks are
defence-in-depth only — a hostile renderer that lies about its role still has to produce a valid
Supabase JWT whose `profiles.role` row says `admin`.

### JWT verification (`cloudflare-backup/src/auth.ts:205 verifySupabaseJwt`)

```ts
// HS256 (legacy Supabase JWT secret) is deliberately refused: the Worker only
// ever holds the public JWKS, never a symmetric secret.
if (header.alg !== 'RS256') {
  throw new BackupHttpError(401, 'UNAUTHORIZED', 'Only RS256 access tokens are accepted');
}
...
const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
signatureValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, ...);
if (!signatureValid) throw new BackupHttpError(401, 'UNAUTHORIZED', 'The sign-in token signature is invalid');
...
if (exp !== undefined && nowSeconds >= exp) throw new BackupHttpError(401, 'UNAUTHORIZED', 'The sign-in session has expired');
if (nbf !== undefined && nowSeconds + 30 < nbf) throw new BackupHttpError(401, 'UNAUTHORIZED', 'The sign-in token is not valid yet');
if (typeof sub !== 'string' || sub.trim().length === 0) throw new BackupHttpError(401, 'UNAUTHORIZED', 'The sign-in token has no subject');
```

The signature is checked over the exact received `header.payload` bytes, never over a re-serialised
copy of the claims. Keys come from `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`, cached 10 minutes
and served stale on a JWKS outage rather than failing every request (`loadJwks`, auth.ts:129).

### Server-side role lookup — current `profiles` role, not JWT claims (`auth.ts:297`)

```ts
const url = `${restBase(env)}/profiles?id=eq.${encodeURIComponent(claims.sub)}&select=role`;
response = await deps.fetchImpl(url, {
  headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}`, accept: 'application/json' },
});
...
if (role === 'admin') return 'admin';
if (role === 'office') return 'office';
return null;
```

The **user's own JWT** plus the public anon key; RLS on `profiles` means the query can only ever
return the caller's own row. No `role` sent by the client is read anywhere — the only role field in
the desktop code is used to decide *whether to call*, and the Worker ignores it.

`authenticate()` (auth.ts:373) then requires a non-null role and, for `office`, the approval RPC.
`requireAdmin()` (auth.ts:392) wraps it for list/download. Upload accepts admin **or** an approved
Office session (`requireAdminOrApprovedOffice`, routes.ts:269).

### Role revocation

Immediate. The role is re-read from Postgres on **every** request — there is no role cache in the
Worker. Demoting an admin in `profiles` takes effect on their next backup call; an already-issued
access token no longer carries authority once the row changes.

### Office approval

`lookupOfficeApproval()` (auth.ts:334) POSTs to
`{SUPABASE_URL}/rest/v1/rpc/office_session_is_approved` with the user's JWT and the anon key, and
accepts only a literal `true`. That function is the existing `SECURITY DEFINER` RPC from
`ARENA/sql/office-approval.sql` — it reads `auth.jwt()` itself (matching `auth.uid()` and
`auth.jwt()->>'session_id'` against non-expired `office_signin_requests`), so the Worker never sees
or trusts an approval claim. No new SQL was added. Revoking or expiring an approval stops Office
uploads on the next request.

### Defence-in-depth layers (not the boundary)

- `electron/preload/index.ts`: `validateAdminBackupInput` and friends reject a non-admin payload
  before `ipcRenderer.invoke`.
- `electron/main/backup-ipc.ts`: `requireAdmin()` refuses `clearance === 'office-pending'`, refuses
  any reported session role that is not `admin`, and requires `payload.role === 'admin'`.
  13 tests in `tests/backup-ipc.test.ts`.

---

## 4. Encryption and key recovery

### Where the key lives

| Thing | Location | Protection |
| --- | --- | --- |
| 256-bit data key | `<userData>\backup-key.bin` on the PC that created it | `safeStorage.encryptString` (DPAPI on Windows), file mode `0600` — `setupKeyGenerate`, backup-service.ts:302 |
| Key verification hash | `sync_meta` key `dks.backup.keyHash` (SHA-256 of the key) | local SQLite; never leaves the PC; never in a snapshot (`sync_meta` is excluded) |
| Recovery key | base64 of the same 32 bytes, shown **once** in the wizard | nowhere in storage — only on the administrator's copy |
| Plaintext key | never written to disk, never sent anywhere | `wrapKeyForStorage` throws `KEY_UNAVAILABLE` if `safeStorage.isEncryptionAvailable() !== true` |

### Who can retrieve it

- Anyone with OS-level access to that Windows user profile (DPAPI is per-user, not per-app).
- Anyone holding the recovery key string.
- Nobody from the cloud: the Worker and R2 never see the key, and the envelope is opaque to them.

### Recovery on a replacement PC — fixed in round 2

`setupKeyGenerate()` creates a **new** random key and `setupKeyConfirm()` only compares a typed key
against the local `dks.backup.keyHash`, which does not exist on a fresh PC. **Round 2 adds the
missing third path**: `BackupService.setupKeyImport(recoveryKey, expectedKeyId?)`
(`electron/main/backup-service.ts`), reachable through IPC `action:'import'`, preload and Settings →
*"Open backups made on another PC"*. It:

- parses the key and rejects anything that is not a 32-byte DKS recovery key;
- optionally checks it against a requested `keyId`, so an administrator can ask for the key that
  opens a specific backup and be told plainly when they hold a different one;
- **refuses to replace a different key already stored on this PC** — the conflicting-key case is a
  decision, not a silent overwrite;
- wraps it with `safeStorage`, writes `<userData>\backup-key.bin` mode `0600`, stores only
  `dks.backup.keyHash`, and **fails closed with no plaintext fallback** when `safeStorage` is
  unavailable;
- never writes the plaintext key: `tests/backup-key-import.test.ts` dumps every SQLite table with
  `better-sqlite3` and scans every file under `userDataPath` (utf8 and base64) and every log line.

So a replacement PC can now resume the old lineage: import → the old backups decrypt and pass
`integrity_check` → automated backups continue under the same key and `keyId`. What PR1 still has no
answer for is applying one (§5): there is no restore, so proving a backup opens is the limit.
`testDrill(recoveryKey)` remains available as a one-off check that stores nothing.

### Multi-PC caveat

Each PC that runs the wizard has its **own** key, and the envelope/metadata carries **no key id**
(`BackupMetadata` = plaintextSha256, fingerprint, appVersion, schemaVersion, recordCounts,
createdAt). If more than one PC uploads, you must know which PC produced an object to know which
recovery key opens it. **Recommendation for PR1: enable cloud backup on one designated admin PC
only.** Adding a key id to the metadata is a small PR2 change.

### What email OTP would authorize

Only a **destructive cloud operation** — a PR2 delete or a PR3 restore *request*. It would be a
second, fresh authentication of the human. It does **not** and cannot authorize decryption:
decryption is purely a function of holding the 32-byte key. In PR1 the hook refuses everything:

```ts
export function requireStepUp(_request: Request): never {
  throw new BackupHttpError(403, 'STEP_UP_REQUIRED', 'Deleting or restoring backups is not available yet');
}
```

### Loss scenarios

| Lost | Consequence |
| --- | --- |
| The PC, recovery key kept | Existing backups are decryptable with the key. PR1 offers no restore, so applying them needs manual tooling (decrypt → open the SQLite file). |
| The PC and the recovery key | **Unrecoverable.** AES-256-GCM with a random 96-bit IV per file; there is no escrow. |
| Supabase access | The Worker returns 401/403 and backups stop. Objects already in R2 remain, but only reachable through the Worker (or by the Cloudflare account owner in the R2 console). |
| Recovery key only | The current PC keeps working (it holds the DPAPI-wrapped key). A replacement PC cannot open the old backups. |
| Cloudflare account | All backups are lost. There is no second copy. |

---

## 5. Restore

**Not implemented in PR1. Only proposed.** There is no restore code path anywhere:

- No `DELETE`/`PUT` route in `cloudflare-backup/src/routes.ts`; `assertDestructiveAllowed()` exists
  and the step-up hook always throws.
- The UI's Recover and Delete buttons are rendered `disabled` with `title="Coming in a later update"`.
- `tests/cloud-backup-security.test.ts` asserts no `handleDelete`/`handleRestore`/`handleReplace`
  exists and no `'DELETE'`/`'PUT'` method is handled.

What exists instead is the **test-restore drill** (`testDrill`, backup-service.ts:864): download the
newest verified object to a temp path → decrypt → verify the GCM tag and the plaintext SHA-256 →
open the decrypted copy read-only → `PRAGMA integrity_check` → delete **both** temp files on every
path (`finally { if (filePath) safeRemove(filePath) }`). It never opens, writes or replaces the live
database.

**Do not describe recovery as production-ready.** A real restore (PR3) still needs, and does not
have: a pre-restore safety snapshot of Supabase; cross-PC coordination so no other DKS instance is
mid-write; draining or quarantining the local outbox; an atomic apply with rollback; post-restore
verification and reconciliation against what was in the cloud; and a decision about rows created in
the cloud after the backup was taken. None of that is written, designed in code, or tested.

---

## 6. Scheduling and deployment

### It runs only when this PC is running DKS with an authorized session

All four gates are in `shouldRunTrigger()` (`electron/main/backup-scheduler.ts`):

```ts
if (!state.enabled)            return { run: false, reason: 'disabled', ... };
if (!state.keyConfigured)      return { run: false, reason: 'no_key', ... };
if (!state.workerConfigured)   return { run: false, reason: 'not_configured', ... };
```

`workerConfigured` is `Boolean(this.credential) && Boolean(workerUrl)` (backup-service.ts:661) — so
a signed-out session cannot even queue a snapshot. `client()` additionally throws `UNAUTHORIZED`
without a credential.

- **T1 (launch):** fired from `BackupService.setSession()`, because the Supabase JWT only exists
  once the renderer has restored a session. Guarded by `autoLaunchCheck` + `launchCheckDone`.
- **T2 (quit):** `installLifecycleListeners`' `before-quit` (index.ts:917) — `preventDefault()`,
  `runBeforeQuit(QUIT_BACKUP_BUDGET_MS = 8000)`, then `app.quit()`. Skipped entirely while an
  auto-update is installing (`updateInstallInProgress`, now actually set by
  `flushSessionStorageBeforeInstall`).
- **T3 (hourly):** `startHourlyTimer()` called from `openLocalStore` (index.ts:641), stopped in
  `closeLocalStore`.
- One `BackupSingleFlight` per process; a second caller joins the in-flight run.
- Everything is wrapped so a backup failure can never stop DKS: `BACKUP_START_FAILED` is reported and
  the service is left undefined (index.ts:644-655).

**Offline / missed-day behaviour:** a day with no launch produces **no backup for that day** — there
is no service and no catch-up of past days. The next launch backs up the state as it is then. A
failed attempt retries after `RETRY_AFTER_FAILURE_MS` (15 min) rather than waiting for the next
Muscat midnight. This is stated in the UI ("Backups run only while DKS is open…") and in `HANDOFF.md`.

### Cloudflare resources

| Resource | Value | Notes |
| --- | --- | --- |
| Worker | `name = "dks-backup"`, `main = "src/index.ts"`, `compatibility_date = "2025-01-01"` | `cloudflare-backup/wrangler.toml` |
| R2 bucket | `dks-backups`, binding `DKS_BACKUPS` | **Private.** No R2.dev subdomain, no public ACL, no custom public domain |
| Cron | `17 2 * * *` | Retention; **dry-run** by default |
| Secret | `SUPABASE_URL` | e.g. `https://<project>.supabase.co` |
| Secret | `SUPABASE_ANON_KEY` | anon/public key only. There is no service-role key in this Worker |
| Secret (optional) | `RETENTION_MODE` | only to turn deletes on: `enforce`. Default var is `dry-run` |
| Var | `RETENTION_DAYS = "90"` | |

Nothing else: no KV, no D1, no Durable Objects, no queues, no custom domains.

### Pricing and quota assumptions — **confirm with Cloudflare before relying on these**

Figures below come from third-party 2026 write-ups of Cloudflare's published rates, not from a
Cloudflare page I fetched; treat them as planning assumptions.

- **R2 free tier:** 10 GB-month storage, 1,000,000 Class A ops (PUT/LIST), 10,000,000 Class B ops
  (GET/HEAD) per month, **zero egress**. Beyond that: $0.015/GB-month, $4.50 per million Class A,
  $0.36 per million Class B.
  ([1](https://leanopstech.com/blog/cloudflare-r2-pricing-2026/), [2](https://nayankyada.com/blog/cloudflare-r2-pricing-2026-free-tier-limits-egress-costs-when-to-upgrade), [3](https://flarecalc.com/calculators/r2/))
- **DKS volume:** one measured snapshot of a 1,200-row cache is **65,571 bytes** encrypted
  (`tests/backup-offline-queue.test.ts` fixture). Even a few uploads a day for 90 days is a few MB —
  far inside the free tier. Class A ops are single-digit per day.
- **Workers:** memory is **128 MB per isolate on every plan** and cannot be raised; CPU is
  **10 ms per request on Free** vs 30 s default on Paid; Free is 100,000 requests/day.
  ([4](https://markaicode.com/errors/cloudflare-workers-memory-limit-fix/), [5](https://www.hesham.us/cloudflare-field-manual/cloudflare-workers-limits-cpu-time-not-wall-time))
- **Recommendation: Workers Paid (~$5/month).** Each upload does an RSA signature verification, a
  SHA-256 over the payload, and two PostgREST subrequests — realistic on Paid's 30 s CPU budget,
  risky inside Free's 10 ms.

---

## 7. Open risks, ranked

1. **FIXED (round 2) — the upload path buffered the whole body and its declared limit was unachievable.**
   `handleUpload` (`cloudflare-backup/src/routes.ts`) now streams `request.body` into
   `DKS_BACKUPS.put()` through a counting `TransformStream`, after a 7-byte envelope probe; passing
   `MAX_UPLOAD_BYTES` (200 MB) errors the stream, the put rejects, the client gets `413
   PAYLOAD_TOO_LARGE` and **no object is written**. `content-length` is still checked as a cheap
   early refusal but the cap no longer depends on it. Peak isolate memory is one chunk. Pinned by
   `tests/backup-worker.test.ts` › "returns 413 when the streamed body exceeds the limit", "writes
   no object at all when the upload exceeds the limit", "stores a below-limit streamed upload byte
   for byte". Original finding:
   `handleUpload` (routes.ts:219) does `const bytes = new Uint8Array(await request.arrayBuffer())`
   while `MAX_UPLOAD_BYTES = 200 * 1024 * 1024`. Workers give **128 MB per isolate on every plan**,
   so a 200 MB (or even ~100 MB) upload cannot succeed — it would die on memory, not on a clean 413.
   Real DKS snapshots are tens of KB, so this is latent rather than daily, but the stated limit is
   wrong and a large dataset would fail confusingly. **Not fixed — needs your decision.** Fix: stream
   `request.body` into `DKS_BACKUPS.put()` through a `TransformStream` that counts bytes and aborts
   past the cap (and keep the cheap `content-length` pre-check), or lower `MAX_UPLOAD_BYTES` to
   something the isolate can hold. `handleGetObject` already streams and does not have this problem.
2. **No restore.** See §5. Recovering real data today means decrypting an object by hand.
3. **FIXED (round 2) — key id now in the metadata.** `keyId` (first 12 bytes of `SHA-256(key)`, hex)
   is a required `BackupMetadata` field, is part of the AES-GCM AAD, and travels through R2 custom
   metadata, HEAD/GET headers, list rows, `BackupState`, history and the Settings status grid.
   `tests/backup-envelope.test.ts` proves it is stable per key, differs per key, and cannot be
   relabelled without breaking the tag.
4. **FIXED (round 2) — recovery-key import on a replacement PC.** `BackupService.setupKeyImport()`,
   reachable through IPC (`action:'import'`), preload and Settings → *"Open backups made on another
   PC"*. `tests/backup-key-import.test.ts` imports a key made on another PC and opens that PC's
   backup end to end through the drill; it also proves invalid keys are refused, a conflicting key
   already on the PC is refused, the wrong key fails at `decrypt` without touching live data, and
   the plaintext key never reaches SQLite, any file under `userDataPath`, or a log line.
5. **FIXED (round 2) — the cache pull is paginated.** `selectTable()`
   (`src/features/sync/supabase-sync.ts`) walks `order('id').range()` pages of 500 until a short
   page arrives, with a 100 000-row hard stop, and raises on a failed page instead of returning a
   partial cache. `tests/backup-cache-completeness.test.ts` pulls 2 340 rows past a simulated
   1 000-row server cap and asserts the exact page ranges. This was pre-existing sync behaviour,
   not introduced by PR1 — but it bounded what "complete snapshot" could mean, so it had to go.
   Remaining and deliberate: a row written while the walk is running can shift a page boundary; the
   reconcile step is an idempotent upsert, so a repeat is harmless and the next pull catches a miss.
6. **JWT hardening gaps.** `verifySupabaseJwt` checks `alg`, signature, `exp`, `nbf` and `sub`, but
   not `iss` or `aud`. Risk is low (the signature must match *this project's* JWKS keys), but both
   checks are cheap. Separately, `keyCache` is keyed by `kid` and never invalidated, so a rotated key
   that reused a `kid` would verify against the stale key.
7. **`runBeforeQuit` can overstate what happened.** On timeout it returns
   `detail: 'Backed up locally; the upload will finish at the next launch'` — true only if the
   snapshot had already been written when the budget expired. If the timeout fires earlier, nothing
   was backed up.
8. **No sweep of orphaned temp files.** `backups/tmp` holds the plaintext snapshot during a run and
   the encrypted download during a drill. Both are removed in `finally`, but a process killed
   mid-run (including by the 8 s quit budget or an NSIS force-kill) can leave one behind. No startup
   cleanup exists. Disk litter only — no data or key exposure, since the temp plaintext is deleted
   on every normal path and the drill's decrypted copy is removed in its own `finally`.
9. **Retention is dry-run**, so R2 grows without bound until PR2. Harmless at these object sizes,
   but it is a real "no deletion yet" fact.
10. **The fingerprint ignores `audit_log`, `notifications` and `conflicts`.** A change confined to
    those tables will not trigger a run on its own; they are still captured whenever any run happens.
    Deliberate (they are derived/mirror data), but worth knowing.

---

## 8. Implemented vs planned

| Capability | Status |
| --- | --- |
| Point-in-time snapshot in main (never copies the live file) | Implemented, tested |
| Excluded operational tables, integrity-verified copy | Implemented, tested |
| AES-256-GCM `DKSBK1` envelope, AAD-bound plaintext SHA-256 | Implemented, tested |
| `safeStorage`-wrapped key, one-time recovery key, SHA-256-only at rest | Implemented, tested |
| T1/T2/T3 triggers, single flight, retry backoff, Muscat calendar | Implemented, tested |
| Bounded outbox drain; `incomplete` instead of a partial snapshot | Implemented, tested |
| Offline pending queue; delete only after server checksum match | Implemented, tested |
| Fingerprint of the confirmed snapshot recorded (not the current one) | Implemented, tested (this review) |
| Upload / list / download / health Worker routes, server-generated keys | Implemented, tested against a fake R2 |
| JWKS RS256 verification, PostgREST role lookup, Office approval RPC | Implemented, tested with a real WebCrypto key pair — **never against live Supabase** |
| Admin-only IPC + preload validation | Implemented, tested |
| Settings UI: status card, wizard, drill, lazy history, disabled Recover/Delete | Implemented, tested in jsdom — **not verified on a real PC or in both themes** |
| Retention cron | Implemented as **dry-run only** |
| Email-OTP step-up | **Hook only** — always refuses |
| Delete one backup / month-year policy | **Planned (PR2)** — not written |
| Restore / replace-restore into Supabase | **Planned (PR3)** — not written; not production-ready |
| Recovery-key import on a replacement PC | **Not implemented** |
| Key id in backup metadata | **Not implemented** |
| Streaming upload inside the Worker memory limit | **Not implemented** — see risk 1 |
