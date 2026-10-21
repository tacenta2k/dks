# DKS — Resume Next Session

This note records the latest Windows checks and what remains. Read this before making changes.

## Repository and safety

- Repository: https://github.com/tacenta2k/dks
- Expected branch: `main` — confirm with `git branch --show-current`.
- Last known WIP checkpoint: `9c08b5e` — confirm the actual latest commit with `git log -5 --oneline`.
- Do not discard or reset WIP changes without the user's approval.
- Do not commit `.env`, passwords, service-role keys, database connection strings, Resend keys, GitHub tokens, or real office records.
- The repo is public. Never put secrets or real client data in it.

## Product requirements that must remain true

- Windows Electron app named DKS; app ID `com.dks.tracker`.
- Supabase is the cloud database; SQLite is only the local offline cache.
- **No automatic backups:** no Supabase Storage backup bucket, no backup-copy feature, no Backup Now button, and no automatic local CSV/JSON backup files.
- Keep only explicit, user-initiated CSV/XLSX import/export and Print/PDF reports. These are admin-only.
- Admin and office permissions must be enforced by Supabase RLS, not just hidden UI controls.
- Office users can edit expiry-date values, including the primary expiry date. Only an admin can change which expiry column is primary.
- Days Left is based on the primary expiry column and remains the locked final grid column.
- Do not weaken login or production security just to make tests pass.
- Never ask the user to send passwords or secret keys.

## Latest checks on this PC

Environment:
- Windows 10.
- Node `v24.21.0`, npm `11.19.0`.
- The project requires Node `>=20.19.0 <21`; use the pinned Node version from `.nvmrc` before final verification/build.
- `.env` was created locally. Check its variable names against `.env.example`; never print or commit its contents.

Results:
- `npm ci`: completed, but reported the Node engine mismatch and that install scripts for `better-sqlite3`, `core-js`, `electron`, and `esbuild` were not approved. Review/approve only the expected package scripts using npm's instructions before relying on Electron/native SQLite.
- `npm test`: 33 test files; 31 passed and 2 failed. Overall: 126 passed, 5 failed.
- Four failures are in `tests/app-shell.test.tsx`; they expect obsolete Step-1 placeholder text/buttons.
- One failure is in `tests/sheet-page.test.tsx`; it expects a workspace test bypass despite the real login flow.
- Investigate and update the tests to use the current authenticated test setup. Do not restore a production login bypass or simply delete tests without replacing their coverage.
- `npm run typecheck`: passed.
- `npm run build`: passed. Vite emitted CJS API deprecation and large-chunk warnings.
- `npm ci` reported 28 audit vulnerabilities (including 4 critical). Inspect the audit report before release; do not run `npm audit fix --force` blindly.
- `supabase/schema.sql` was run in Supabase SQL Editor and returned “Success. No rows returned.” That is normal for DDL, but verify the seeded rows separately.
- Live app login, RLS, cloud sync, notifications, and the Windows installer have not yet been verified.

## Next steps

1. Inspect `git status --short`, `git branch --show-current`, and `git log -5 --oneline`. Preserve existing work.
2. Confirm `.env` is ignored and not tracked. Check the variable names against `.env.example` without displaying the values.
3. Use Node 20.19.0 as specified by `.nvmrc`. Review npm's blocked lifecycle-script list and approve only the expected packages needed for Electron, esbuild, and better-sqlite3. Rebuild Electron native dependencies as appropriate.
4. Fix the five failing tests to reflect the real login flow. Then run:
   - `npm test`
   - `npm run typecheck`
   - `npm run build`
5. Verify the Supabase schema seed in SQL Editor using:
   ```sql
   select * from public.profiles;
   select * from public.settings;




---

# UPDATE — AFTER FIRST PACKAGED EXE TEST

This section supersedes the "Next steps" above where they conflict.
Written after running the real Windows app, not the browser preview.

## Major discovery: browser preview is not the app

`npm run dev` starts Vite at `127.0.0.1:5173`. Opening that URL in a browser
is NOT the application: there is no `window.dks` bridge and no SQLite, so
rows live only in memory and vanish on refresh. Several earlier "bugs" were
caused by testing there. Always test in the packaged exe or a real Electron
window.

## Now verified working (packaged exe: release\win-unpacked\DKS.exe)

- App launches; login works; session persists (login once per PC).
- Data saves: Supabase `entries` and `app_columns` receive rows — confirmed
  in Supabase Table Editor.
- Typing into grid cells works (an earlier "cannot type" report was a
  mistake: the user had clicked the non-editable Actions column).
- Add Column wizard works.
- CSV import created 3 rows in the preview; must be re-verified in the exe.
- Recycle Bin and Audit Log pages work and record actions.
- Dashboard renders.

So: Electron, SQLite, Supabase sync, and auth are all functional.

## Build status

`npm run dist` successfully produced `release\win-unpacked\DKS.exe`
(it runs correctly), then FAILED at the NSIS installer step with:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client
... winCodeSign-2.6.0.7z ... darwin/10.12/lib/libcrypto.dylib
```

This is a Windows permission issue while 7za extracts symlinks, not an app
bug. Fix: run the terminal as Administrator, or enable Windows Developer
Mode, then re-run `npm run dist`. Document this in the README. Also:
electron-builder warns `author is missed in the package.json`, and no app
icon is set (default Electron icon is used).

## Functional decisions (behaviour changes, not visual redesign)

### Passport validation — REMOVE
Customers come from India, Pakistan, Bangladesh, Oman and elsewhere, so
country-specific formats are wrong. Remove all passport format validation
and the red "invalid format" border. Remove the "Passport number column"
checkbox from the Add Column wizard. Passport fields are plain text.
KEEP the duplicate-value warning (same passport in two rows → yellow
highlight + tooltip, never blocking).

### Dates — must be DD/MM/YYYY for the user
Currently the grid shows `YYYY-MM-DD` and typing `10012004` stays as
`10012004`. Required:
- Date-type columns DISPLAY as DD/MM/YYYY in the grid, CSV, Excel, print
  and PDF.
- Typing digits auto-inserts slashes: `10` → `10/`, `1001` → `10/01/`,
  `10012004` → `10/01/2004`.
- Pasting `10012004`, `10-01-2004` or `2004/01/10` normalises to
  `10/01/2004`.
- Keep the date picker.
- Invalid calendar dates (e.g. `31/02/2026`) show a warning but still save.
- The database keeps storing `YYYY-MM-DD`; users never see ISO dates.
This applies only to Date-type columns, not to text columns merely named
"DATE".

### Hard-coded business columns — REMOVE
Remove the seeded/hard-coded Category (Employee/Family/Client), Visa Type
(Visit/Work/Family/Resident) and Notes-as-a-fixed-column, plus the Category
filter dropdown, the "Uncategorized" chip and the hard-coded
"Group by Category" behaviour. Also remove the "Load Visa Template" action
and its seed path. Users build their own columns with the wizard; all
generic column types remain available (text, number, phone, email, price,
date_start, date_expiry, dropdown, checkbox, notes).

## New bugs found

### B1 — Export CSV and Export Excel produce BLANK files (MAJOR)
With one fully filled, visible row: the exported CSV opened in Notepad was
empty, and the exported Excel file opened in Excel was empty. Exports must
contain a header row, the visible user columns, Days Left, and every row
matching the current filter/sort. Investigate which data source the export
reads (in-memory vs SQLite vs Supabase). Re-test inside the exe. Also verify
import end-to-end in the exe: preview, column mapping, rows persisting after
a restart, rows visible in Supabase, and DD/MM/YYYY parsed correctly.

### B2 — Settings page freeze (MAJOR — reproduce in the exe first)
Clicking Settings froze the view, with nothing in DevTools console or the
terminal. This was observed in the browser preview, which is not the real
app. Reproduce in the packaged exe. If it still freezes, the settings load
path probably never resolves (an IPC call or Supabase query without a
timeout); add a timeout plus visible loading and error states. If it does
not freeze in the exe, close this item.

### B3 — `npm run dev` does not visibly open the Electron window (LOW)
Vite starts, but the Electron process (`[1]`) prints nothing and no DKS
window appears, even after `npm rebuild better-sqlite3` and
`npx electron-builder install-app-deps` (both succeeded). `npx electron .`
also produced no window. Add main-process logs ("DKS main started",
"DKS window shown") and ensure a normal dev launch shows the window rather
than starting hidden. Low priority — the exe is the primary test target.

### B4 — Persistence re-check after the above (VERIFY)
In the exe: create a row, fully quit the app (not just hide to tray), reopen
and confirm the row persists locally and in Supabase `entries`. Do the same
for `app_columns` and for a changed Setting. If anything is lost, inspect the
SQLite → Supabase sync queue and the startup snapshot.

## Accepted improvements (small, non-visual)

- S1 Toasts should use a human label (first text column value), not raw ids.
  Seen: `Moved row-02b75364-be0b-4102-8059-bbac2ffe961c to the recycle bin.`
  Wanted: `Moved "Ahmed" to the recycle bin.`
- S2 Recycle Bin should show the row label instead of `row-7ce65046-…`, use
  plain "Restore" and "Delete forever" buttons (with confirmation), show
  "Deleted at" in local time as `DD/MM/YYYY HH:mm`, and show who deleted it
  when that is available.
- S3 Audit Log currently shows Actor "Unknown" for every action, raw action
  names (`soft_delete`, `create`), raw JSON details and UTC timestamps.
  Show the actor's email (join `profiles` on the actor uuid and make sure the
  actor is recorded), friendly action names, readable details with the raw
  JSON expandable, local timestamps, and filters for action, actor and date
  range.
- S4 Verify end-to-end: office deletes a row → admin bell shows
  "Office deleted [label] on [date time]" → View and Restore both work.
- S5 Verify conflict handling: the same row edited on two PCs while offline →
  server version wins, the row is flagged with a tooltip
  "Conflict: also edited elsewhere at [time]", and BOTH versions are written
  to `audit_log`. No silent data loss.
- S6 Verify notifications and tray: toasts at the configured thresholds
  (default 90/60/30/15/7/1/0), no repeat for the same item on the same day,
  tray red dot when anything is expired or ≤7 days, close-to-tray, and
  autostart starting hidden.
- S7 Verify that when an admin changes which expiry column is primary, Days
  Left, row colours and alerts recompute immediately.
- S8 Add an `author` field to `package.json` (silences the electron-builder
  warning). Keep appId and productName unchanged.
- S9 Prepare for an app icon: a square PNG ≥256px converted to
  `build/resources/icon.ico`, referenced from `electron-builder.yml`.

## Suggested order of work

1. B1 exports (and verify import).
2. B2 settings freeze (reproduce in exe first).
3. B4 persistence re-check.
4. Passport removal, date format, hard-coded column removal.
5. S1–S3 label/actor/time formatting.
6. S4–S7 verification of delete-notify, conflict, notifications, primary expiry.
7. Tests (the five failures listed earlier in this file).
8. F/dist: README note about running as Administrator; `author`; icon.

## Still deliberately NOT in this file

The visual/layout redesign of the sheet, toolbar, sidebar and profile menu is
being specified separately with the user. Do not start any UI redesign from
this file. Behaviour changes listed above are allowed even if they remove a
button (for example the passport checkbox or the template action).

## User tasks still pending

- [ ] Reset both Supabase user passwords (Authentication → Users → Send
      password recovery). Do NOT delete the users; their UUIDs are seeded.
- [ ] Optional: Resend API key and recipient in Supabase Edge Function
      secrets; the app must work fully without email.
- [ ] Provide a square PNG ≥256px for the app icon.





## Additional issue — Recycle Bin permanent delete fails

- As Admin, clicking “Permanently delete” in the Recycle Bin fails.
- Electron reports:
  `Error invoking remote method 'dks:local:permanent-delete-row':
  TypeError: Cannot read properties of undefined (reading 'ensureOpen')`
- Expected: after confirmation, permanently delete the record, update local
  SQLite and Supabase consistently, refresh the Recycle Bin, and record the
  action in the audit log.
- Investigate the IPC handler, preload bridge, repository/store initialization,
  and any `ensureOpen` call. Do not merely suppress the exception.
- Enforce Admin authorization on the server/RPC as well as in the UI.
- Add tests for successful permanent deletion and rejection of a non-admin.
- Be careful about partial completion: check the test record in both the app
  and Supabase before retrying, since the error alone does not prove whether
  a local or remote delete already happened.