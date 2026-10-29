# DKS — Resume Next Session (Non-UI Bugs and Functional Work)

Read `HANDOFF.md` first, then this file, then `docs/FIXES_UI.md`.

This file covers environment checks, verified behaviour, functional decisions
and non-UI bugs. Complete this work before starting the UI redesign.

Note: statements here reflect what was observed on one Windows machine at the
time of testing. Re-verify on the current machine before relying on them.

---

## 1. Repository and safety

- Repository: https://github.com/tacenta2k/dks (public)
- Expected branch: `main` — confirm with `git branch --show-current`.
- Confirm the real current state with `git status --short` and
  `git log -5 --oneline`. Do not assume a specific commit hash.
- Do not discard, reset or revert existing work without the user's approval.
- Never commit `.env`, passwords, service-role keys, database connection
  strings, Resend keys, GitHub tokens, or real customer records.
- The repository is public: no secrets and no real client data.

---

## 2. Product requirements that must remain true

- Windows Electron app named DKS; app ID `com.dks.tracker`.
- Supabase Postgres is the cloud database. SQLite is only the local offline
  cache and sync queue.
- No automatic backups: no Supabase Storage backup bucket, no backup-copy
  feature, no "Backup Now" button, no scheduled or automatic local
  CSV/JSON/Excel backup files.
- Keep only explicit, user-initiated CSV/XLSX import/export and Print/PDF
  reports, restricted to Admin.
- Enforce Admin/Office boundaries with RLS and server-side functions, and
  also with role checks in the Electron/IPC and service layer. Hiding a
  button is not sufficient.
- Office users can edit expiry date values, including the primary expiry
  value. Only Admin can choose which column is the primary expiry column.
- Days Left is computed from the primary expiry column and stays the locked
  final grid column.
- Do not weaken login, RLS or production security to make tests pass.
- Never ask the user for passwords or secret keys.

Important limitation to state honestly: Office users must be able to read
records to use the sheet. Database-level read access cannot distinguish
"viewing" from "exporting". Admin-only Import/Export/Print is therefore an
application policy enforced in the app and its IPC/service layer, not a
guarantee that a determined Office user could never read data through other
means. Do not claim otherwise.

---

## 3. Environment and tooling

Observed environment:
- Windows 10 (reported build 10.0.26100).
- Node `v24.21.0`, npm `11.19.0`.
- The project pins Node `20.19.0` in `.nvmrc` (engines: `>=20.19.0 <21`).
  Prefer the pinned version for final verification and packaging.
- `.env` exists locally and must stay untracked. Compare variable names with
  `.env.example` without printing values.

Reported command results (re-run and confirm):
- `npm ci` completed, but warned about the Node engine mismatch and reported
  that lifecycle scripts for `better-sqlite3`, `core-js`, `electron` and
  `esbuild` were not approved. Approve only expected packages using npm's
  current instructions.
- `npm ci` reported 28 vulnerabilities (4 critical). Review before release.
  Do not run `npm audit fix --force` blindly.
- Native rebuilds succeeded when needed:
  ```bash
  npm rebuild better-sqlite3
  npx electron-builder install-app-deps
  ```
- `npx electron --version` returned `v34.5.8`.
- `npm test`: 33 test files, 31 passed and 2 failed; 126 tests passed and 5
  failed.
- `npm run typecheck`: passed.
- `npm run build`: passed, with Vite CJS deprecation and large-chunk warnings.
- `supabase/schema.sql` was executed in Supabase SQL Editor and returned
  `Success. No rows returned`, which is expected for DDL.

Verify the seed separately:
```sql
select * from public.profiles;
select * from public.settings;
```
Expect the two seeded profiles and the expected settings row(s). Do not re-run
the whole schema casually; prefer a targeted, non-destructive migration if a
change is needed, and let the user run it.

---

## 4. Packaged app vs browser preview

`npm run dev` serves Vite at `http://127.0.0.1:5173`. Opening that URL in a
normal browser is not the application: there is no Electron preload bridge
(`window.dks`) and no SQLite, so data is in-memory only and disappears on
refresh.

Test persistence, IPC, SQLite and sync in the packaged executable
(`release\win-unpacked\DKS.exe`) or a real Electron window. The app should also
make preview mode obvious and warn that preview data is not saved.

Verified in the packaged executable:
- Launches, login works, session persists.
- Rows and columns reached Supabase (`entries`, `app_columns`), confirmed in
  Table Editor.
- Typing in grid cells works. An earlier "cannot type" report was caused by
  clicking the non-editable Actions column.
- Add Column wizard opens.
- Settings page opens (it did not freeze in the packaged app).
- Dashboard, Recycle Bin and Audit Log render and show records.

Still unverified end-to-end:
- All queued sync operations completing successfully.
- Office vs Admin RLS behaviour in practice.
- Realtime sync between two PCs.
- Settings persisting and propagating across machines.
- Admin delete notification, restore, and permanent delete.
- Export/import correctness in the packaged app.
- A successful NSIS installer build and install test.

---

## 5. Build and packaging status

`npm run dist` produced a working `release\win-unpacked\DKS.exe`, then failed
during the NSIS/code-sign stage:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client
... winCodeSign-2.6.0.7z ... darwin/10.12/lib/libcrypto.dylib
```

This is a Windows privilege issue while extracting symlinks from the
`winCodeSign` archive, not an application bug.

Suggested approaches:
- Run the build from an elevated (Administrator) terminal, or
- Enable Windows Developer Mode, then re-run `npm run dist`.

Do not record this as resolved until an installer is produced and installed
successfully. Document the final working procedure in `README.md`.

Also reported:
- electron-builder warns `author is missed in the package.json`.
- No application icon is configured, so the default Electron icon is used.

---

## 6. Functional decisions (behaviour, not visual redesign)

### F1 — Remove passport format validation
Customers come from India, Pakistan, Bangladesh, Oman and elsewhere, so
country-specific formats are wrong.
- Remove passport format checks and the "invalid format" styling.
- Remove the "Passport number column" checkbox from the Add Column wizard.
- Treat passport values as plain text.
- Keep the duplicate-value warning: if the same value exists in another
  active row, show a non-blocking warning.

### F2 — Dates must be DD/MM/YYYY for users
For Date-type columns (`date_start`, `date_expiry`):
- Display `DD/MM/YYYY` in the grid, CSV, Excel, print and PDF.
- While typing digits, insert separators: `10` → `10/`, `1001` → `10/01/`,
  `10012004` → `10/01/2004`.
- Normalise pasted values such as `10012004`, `10-01-2004` and `2004-01-10`
  to `10/01/2004`.
- Keep a date picker available.
- Show a clear warning for impossible dates (for example `31/02/2026`) and do
  not silently convert them to a different date.
- Continue storing `YYYY-MM-DD` in the database; users should not see ISO
  dates.
- This applies only to Date-type columns, not to text columns merely named
  "DATE".

### F3 — Remove hard-coded business columns and template
- Remove seeded Category (Employee/Family/Client), Visa Type
  (Visit/Work/Family/Resident) and a fixed Notes column.
- Remove the Category filter, the "Uncategorized" chip and hard-coded
  "Group by Category" behaviour.
- Remove the "Load Visa Template" action and its seed path.
- Keep generic column types available: text, number, phone, email, price,
  date_start, date_expiry, dropdown, checkbox, notes.

### F4 — Confirm no backup features remain
Search for `backup`, `backups`, `dks-backups`, `storage.buckets`,
`storage.objects`, `Backup Now`, `DKS_Backups`.

Remove real backup implementations, storage policies, scheduled jobs and UI.
Do not delete tests or documentation whose purpose is to assert that backup
functionality is absent.

---

## 7. Bugs

### B1 — Export CSV and Export Excel produced blank files (MAJOR)
With one filled, visible row, exported CSV and Excel files were empty.

- Identify which data source the export reads (in-memory, SQLite, or
  Supabase) and why it produced no rows.
- Exports must include a header row, the visible user columns, Days Left, and
  all rows matching the current search/filter/sort, with dates as DD/MM/YYYY.
- Re-test inside the packaged app.
- Also verify import end-to-end: preview, column mapping, persistence after
  restart, rows visible in Supabase, and correct DD/MM/YYYY parsing.

### B2 — Recycle Bin permanent delete fails (MAJOR)
As Admin, "Permanently delete" fails with:

```
Error invoking remote method 'dks:local:permanent-delete-row':
TypeError: Cannot read properties of undefined (reading 'ensureOpen')
```

- Investigate the IPC handler, preload bridge and store/repository
  initialisation, including the `ensureOpen` call path.
- Do not simply swallow the exception.
- On success: remove the record locally, reflect the deletion in Supabase,
  refresh the Recycle Bin, and record an audit entry.
- Enforce Admin authorisation in the IPC/service layer and server-side.
- Add tests for successful Admin deletion and rejection for Office.
- Because the failure may have been partial, check the record in both the app
  and Supabase before retrying.

### B3 — Sync error with 3 pending changes (MAJOR)
The packaged app showed `Sync error · 3 pending` while signed in as Admin.
Some data reached Supabase; the failing operations are unknown.

- Inspect the local outbox and capture the actual error per operation.
- Check RLS/authorisation, RPC usage, payload shape, timestamps and any
  foreign keys such as `created_by`/`updated_by`.
- Surface a meaningful error in the sync status indicator.
- Retry must be idempotent: no duplicates, no silent loss of local edits.
- Re-verify with fictional test records in the app and Supabase after a full
  restart.
- Do not log customer data or credentials.

### B4 — Settings page issues observed in the packaged app (MAJOR)
Settings opens, so the earlier "freeze" report from browser preview is not
confirmed in the packaged app. However, the screenshots show:

1. The primary expiry selector shows "No primary expiry column" even though an
   expiry column exists. Load Date (Expiry) columns correctly; if exactly one
   exists it should be selectable/auto-detected, and changing it must
   recompute Days Left, colours and alerts.
2. The top bar area appears blank on the Settings page. The global header
   should render consistently on every page.
3. There is no weekly summary control, although daily summary exists. Add
   weekly summary (enable, day, time) and persist it with the other settings.

Also confirm settings actually persist locally and sync to Supabase, and that
save feedback reflects the true sync state rather than always claiming success.

### B5 — Persistence re-check (VERIFY)
In the packaged app: create a row, fully quit (not just hide to tray), reopen,
and confirm the row persists locally and in Supabase `entries`. Repeat for
`app_columns` and for a changed setting. If anything is lost, inspect the
SQLite → Supabase queue and the startup snapshot.

### B6 — `npm run dev` does not visibly open the Electron window (LOW)
Vite starts, but no DKS window appeared, even after native rebuilds;
`npx electron .` also showed no window.

- Add clear main-process logging (startup, window creation, failures).
- Ensure development launch shows and focuses the window instead of starting
  hidden.
- Check single-instance behaviour and any tray-only startup path.
- Lower priority: the packaged executable is the primary test target.

---

### B7 — Login required again after the 0.1.6 → 0.1.7 in-app update (FIXED in 0.1.8, VERIFY)

- The installer path was not the cause: electron-updater 6.8.12 runs the new
  installer with `--updated --force-run` (NsisUpdater `args = ["--updated"]`),
  the old uninstaller gets `/S /KEEP_APP_DATA --updated`, and
  `build/installer.nsh` never writes `.dks-isFresh` when `${isUpdated}`.
  CI case E reproduces this invocation over a real v0.1.6 install and asserts
  no `session-reset-required` and an unchanged nonce.
- The session was lost in the app: un-flushed rotated refresh token killed
  with the app during install, a nonce read error treated as "fresh", a
  transient restore error shown as the login screen. All fixed in 0.1.8
  (flush before install, preserve on read error, restore retry + "Retry saved
  sign-in"). Uninstall/reinstall still requires login.
- VERIFY on Windows: update 0.1.7 → 0.1.8 in-app and stay signed in; then
  uninstall + reinstall and confirm login is required.

### B8 — "Signing in…" slow (FIXED in 0.1.8, VERIFY with field logs)

- Measured: button time = password grant + profile read, serial; before 0.1.8
  a duplicate profile read (and for Office an extra RPC) was added by the auth
  listener. The password grant was also the cold first request to Supabase.
- 0.1.8: one profile read, one Office approval RPC, and the connection is
  pre-warmed (`GET /auth/v1/health`) while the form is shown.
- `main.log` now has `[dks:timing]` lines (durations, outcome, role, error
  code, `warm=yes|no` only — no credentials or customer data). Collect them
  from the affected PC to confirm.

## 8. Smaller improvements (non-visual)

- S1 Use a human-readable label (for example the first text column value) in
  toasts instead of raw IDs. Seen:
  `Moved row-02b75364-… to the recycle bin.`
  Wanted: `Moved "Ahmed" to the recycle bin.`
- S2 Recycle Bin should show the row label instead of `row-7ce65046-…`,
  local `DD/MM/YYYY HH:mm` deletion time, clear Restore and permanent delete
  actions with confirmation, and who deleted it when that information exists.
- S3 Audit Log should show a real actor instead of "Unknown" (ensure the actor
  is recorded and joined to `profiles`), friendly action names, local
  timestamps, readable details with raw JSON available on demand, and filters
  for action, actor and date range. Because Office is a shared account, do not
  imply it identifies an individual person.
- S4 Verify end-to-end: Office deletes a row → Admin notification appears →
  View and Restore work.
- S5 Verify conflict handling: the same row edited on two PCs → server version
  wins, the row is flagged with a tooltip such as
  "Conflict: also edited elsewhere at [time]", and both versions are recorded
  in `audit_log`. No silent data loss.
- S6 Verify notifications and tray: alerts at configured thresholds
  (default 90/60/30/15/7/1/0), no duplicate alert for the same record on the
  same day, tray indication when anything is expired or due within 7 days,
  close-to-tray and autostart behaviour.
- S7 Verify that changing the primary expiry column recomputes Days Left,
  colours and alerts immediately.
- S8 Add an `author` field to `package.json`. Keep `appId` and `productName`
  unchanged.
- S9 Prepare an app icon: a square PNG of at least 256px converted to
  `build/resources/icon.ico` and referenced from `electron-builder.yml`.

---

## 9. Suggested order of work

1. B2 permanent delete crash, including authorisation and tests.
2. B3 sync error with pending changes.
3. B1 exports (and verify import).
4. B4 settings issues, then B5 persistence re-check.
5. F1, F2, F3, F4 functional changes.
6. S1–S3 label/actor/time formatting.
7. S4–S7 verification of notifications, conflicts and primary expiry.
8. The five failing tests, then B6 dev-window visibility.
9. Packaging: resolve the installer build, add `author`, add the icon, and
   update `README.md`.

After this list passes tests, typecheck and build, continue with
`docs/FIXES_UI.md`.

---

## 10. Out of scope for this file

The visual/layout redesign (sheet, toolbar, sidebar, top bar, profile menu and
page layouts) is specified in `docs/FIXES_UI.md`. Do not start UI redesign from
this file. Behaviour changes above are allowed even when they remove a control,
such as the passport checkbox or the template action.

---

## 11. User tasks (the agent must not attempt these)

- [ ] Reset both Supabase user passwords (Authentication → Users → password
      recovery). Do not delete the users; their UUIDs are seeded.
- [ ] Run any approved SQL migration in Supabase SQL Editor.
- [ ] Run the packaging command in an elevated terminal (or with Developer
      Mode enabled) to produce the installer.
- [ ] Optional: configure Resend API key and recipient in Supabase Edge
      Function secrets; the app must work fully without email.
- [ ] Provide a square PNG of at least 256px for the app icon.