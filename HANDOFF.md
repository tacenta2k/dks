# DKS — Project Handoff

Read this file first. Old chat history may not be available on another machine.
The current Git repository and these project documents are the project memory.

## Files to read first

1. `HANDOFF.md` — project overview, security rules, current status, and workflow
2. `docs/RESUME_NEXT_SESSION.md` — non-UI bugs, functional decisions, and verification checklist
3. `docs/FIXES_UI.md` — reviewed UI redesign specification

The non-UI and UI work are tracked separately. Do not create a
`docs/FIXES_NON_UI.md` file unless the user explicitly requests one.

If requirements conflict, do not silently choose a version or invent a new
requirement. Point out the conflict and ask the user.

## What DKS is

DKS is a Windows desktop application (`.exe`) for a small medical/visa office
in Oman. It tracks visas, passports, and document expiry dates in an
Excel-like grid.

Core requirements:

- Supabase Postgres is the cloud database.
- SQLite is used only for the local offline cache and sync queue.
- There are two shared accounts: ADMIN and OFFICE.
- The app supports Windows notifications, a system tray, and automatic updates.
- Real customer data must not be used in public test data or committed to Git.

## Repository and current checkpoint

- Repository: https://github.com/tacenta2k/dks
- Branch: `main`
- The repository is public. Never commit secrets or real customer records.
- Do not pin work to an old commit hash. At the start of a session, inspect the
  actual current state using:

```bash
git status
git branch --show-current
git log -5 --oneline
```

- Preserve existing changes. Do not reset, revert, or check out an older commit
  without the user's explicit permission.
- Continue on top of the current latest commit on `main`.

## Project documentation

- `docs/RESUME_NEXT_SESSION.md` is the detailed source of truth for reported
  non-UI bugs, functional changes, environment observations, and test steps.
- `docs/FIXES_UI.md` is the source of truth for reviewed UI/layout decisions.
- Do not create a fourth requirements file unless the user asks.
- When adding a new issue, update the appropriate existing document and clearly
  distinguish confirmed behavior from something that still needs verification.

## Technology stack

Do not change the stack without asking the user:

- Electron + electron-vite
- React 18
- Strict TypeScript
- Tailwind/app CSS with light and dark themes
- AG Grid Community
- Zustand where already used
- date-fns
- lucide-react
- `@supabase/supabase-js` using the publishable key only
- `better-sqlite3` for local offline cache and outbox
- electron-log
- electron-builder for Windows NSIS packaging
- electron-updater for GitHub Releases
- Recharts
- SheetJS/xlsx for user-initiated CSV/XLSX import and export
- jsPDF + jspdf-autotable for PDF reports

Node:
- `.nvmrc` pins Node `20.19.0`.
- Some work was tested with Node `v24.21.0`; prefer the pinned Node version
  for repeatable verification where possible.
- Do not change Node or dependency versions casually.

Docker and Makefile:
- They may exist for reproducibility, but are not app features.
- They are not required for normal Windows testing.

## Environment variables

Create `.env` locally in the project root. Never commit `.env`.

```env
VITE_SUPABASE_URL=https://vjhlccafuqupbxajccvy.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_ETVdXQdfIfGeOyICJ-G6Mg_uv24shQk
```

The Supabase key above is a publishable key, intended for client applications.
Database security must come from RLS and appropriate server-side functions, not
from hiding this key.

Never request, use, or commit:

- Supabase service-role/secret key
- Supabase database password
- Postgres connection string
- User passwords
- GitHub token
- Resend API key in client code

## Supabase project and users

Project URL:

```text
https://vjhlccafuqupbxajccvy.supabase.co
```

Existing Auth users:

```text
ADMIN
  email: shahabasnavas123@gmail.com
  UUID: 846536af-f3c6-47c1-8559-d13442c1490a

OFFICE
  email: amervisamedical1dks@gmail.com
  UUID: 2a959122-d789-4f2e-8fdf-958260c2e3f9
```

Important:

- These are shared accounts. An audit event can identify the Admin or Office
  account, but cannot identify which individual staff member used the shared
  Office login. Do not imply otherwise.
- User passwords are never stored in code or documentation. Users enter them
  in the app when signing in.
- The user was advised to reset passwords because they appeared in an earlier
  chat. Confirm whether this has been done, but never ask the user to disclose
  a password.
- Do not delete or recreate these Auth users. Their UUIDs are referenced by
  the schema seed.
- Supabase has “Automatically expose new tables” disabled. SQL must keep
  explicit grants to the required roles, including `authenticated`.

Schema status:

- `supabase/schema.sql` has already been run in Supabase SQL Editor.
- Supabase returned `Success. No rows returned`, which is normal for DDL.
- Do not ask the user to run the same schema again without first inspecting
  whether it is safe and necessary.
- If a future database change is required, prepare an appropriate migration
  and explain its effects. The user runs SQL manually.

## Security and permissions

Roles:

- `admin`
- `office`

Office users can:

- View active rows and columns.
- Add, edit, and duplicate rows.
- Soft-delete rows with confirmation.
- Add columns.
- Use the supported row/column operations allowed by the current permission
  rules.
- Delete a column only if it is empty, with the empty check enforced by the
  server/database.
- Edit date values in any expiry column, including the primary expiry value.
- Mark records as renewed.
- Use the permitted reminder snooze/dismiss actions.

Office users cannot, within the DKS application:

- Import, export, or print/PDF.
- Open Settings, Audit Log, or Recycle Bin.
- Restore or permanently delete rows.
- Delete a column containing data.
- Choose or change which expiry column is primary.

Admins can perform all supported operations, including the restricted
administrative operations above.

Security implementation requirements:

- Use RLS and server functions for database access controls.
- Enforce role restrictions in the app’s service/Electron IPC layer as well as
  the renderer. Hiding a button alone is not enough.
- Do not put privileged service-role credentials in the desktop application.

Important limitation — do not overstate export security:

Office users need permission to read records in order to use the sheet.
Database read access does not, by itself, distinguish “displaying records” from
“exporting records.” Therefore, RLS alone cannot prevent a technically capable
Office user from querying records outside the DKS interface. The app can enforce
Admin-only Import/Export/Print controls as an application policy, with role
checks in its service and Electron handlers. Do not claim that RLS makes the
records impossible to extract by an Office client. If the user requires that
stronger guarantee, explain the architecture trade-off and ask before changing
the data-access design.

## Data, column, and date rules

The sheet starts with no pre-seeded user columns. Users create columns through
the column setup flow.

Do not add hard-coded business columns or values:

- No pre-seeded Category column or Employee/Family/Client options.
- No pre-seeded Visa Type column or Visit/Work/Family/Resident options.
- No pre-seeded Notes or Country column.
- No “Load Visa Template” action.
- Users may create their own Text, Dropdown, or Notes columns when needed.

Supported generic column types include:

- Text
- Number
- Phone
- Email
- Price/Amount
- Date, followed by Start Date or Expiry Date
- Dropdown
- Checkbox
- Notes

Date rules:

- All user-visible dates use `DD/MM/YYYY`.
- The database stores dates as `YYYY-MM-DD`.
- Date typing and paste should normalize to `DD/MM/YYYY` for the UI.
- Only a `date_expiry` column can drive Days Left.
- Multiple expiry columns are allowed, but one is designated Primary Expiry.
- Only Admin chooses or changes the Primary Expiry column.
- Office users can still edit date values in expiry columns.
- Invalid dates may show a visual warning but should not silently change to a
  different date.

Passport rules:

- Passport values are plain text.
- Do not apply an Oman-specific or other country-specific passport format rule.
- Do not add a “Passport number column” validation checkbox.
- Duplicate passport values may show a non-blocking yellow warning.

Phone and email format warnings may be visual-only and must not block saving.

Days Left:

- Computed from the Primary `date_expiry` value and the local calendar date.
- Always the final/far-right locked column.
- Not user-editable, deletable, or reorderable.
- Recalculated when the expiry value, primary column, or local date changes.

## Privacy and file handling

**Superseded in part on 2026-10-31 (cloud backup Phase 1).** The owner asked for
an encrypted cloud backup of the local SQLite cache. The rule below is no longer
absolute; what changed, and what still holds, is stated inline.

No backups of any kind ~~(superseded — see the exception below)~~:

- No automatic local CSV/Excel/JSON backup files. **Still true.** Nothing writes
  CSV/XLSX/JSON snapshots, and no snapshot ever leaves the app folder unencrypted.
- No scheduled exports. **Still true.** The only scheduled work is the encrypted
  SQLite snapshot described below; it is not an export and produces no
  human-readable file.
- No Supabase Storage backup bucket. **Still true.** Backups go to Cloudflare R2
  through a Cloudflare Worker, never to Supabase Storage, and `supabase/schema.sql`
  still contains no `storage.buckets` policy.
- No `dks-backups` bucket. **Superseded.** A private Cloudflare R2 bucket named
  `dks-backups` now exists. It is private (no R2.dev, no public ACL), reachable
  only through the Worker, which verifies a Supabase JWT and looks the role up in
  Postgres. No R2 credential ships in the `.exe`.
- No “Backup Now” control. **Superseded.** Settings → Backup & Recovery (Admin
  only) has a “Back up now” button plus a “Test restore” drill. There is still no
  restore and no delete in the UI — both appear disabled with “Coming in a later
  update”.
- SQLite is permitted only for the live offline cache and sync queue; it is
  not an additional export/backup feature. **Still true.**

The one exception, and its limits:

- Content: a point-in-time copy of the local SQLite cache, taken in the Electron
  **main** process with `better-sqlite3` `backup()` (falling back to `VACUUM INTO`).
  The live file is never copied directly.
- Encryption: AES-256-GCM (`node:crypto`) with a 32-byte key generated on the PC
  and wrapped by `safeStorage` (DPAPI on Windows). The plaintext key is never
  stored; only its SHA-256 is kept so the recovery key can be checked.
- Envelope: `DKSBK1` magic, version, 96-bit IV, GCM tag, ciphertext, with the
  plaintext SHA-256 bound into the authenticated metadata.
- Excluded from every snapshot: `outbox`, `sync_meta`, `error_report_queue`,
  `error_report_dedupe`. Auth/session data never enters the snapshot at all — it
  lives in Electron session storage, not SQLite.
- Triggers: first launch of the Muscat day, hourly while DKS runs, and once
  before quit inside a bounded window. **Backups only happen while DKS runs.**
- Retention: a Worker cron keeps 90 days and is **dry-run** — it logs what it
  would delete and deletes nothing until `RETENTION_MODE=enforce` is set.
- Never overwritten: an upload is only marked successful after the Worker
  re-reads the stored object and returns a matching SHA-256.

Keep explicit, user-initiated CSV/XLSX import/export and Print/PDF for Admin
only. These are data exchange/report features, not automatic backups.

A code search may find tests or documentation whose purpose is to assert that
backup functionality is absent. Do not delete such tests or documentation
blindly; remove actual backup implementation, storage policies, schedules, and
UI. The suite that used to assert absence was `tests/backup-removal.test.ts`;
it has been replaced by `tests/cloud-backup-security.test.ts`, which asserts the
*boundaries* instead (no service-role key, no R2 secret in the app, no renderer
Node/crypto access, no delete/restore route, private bucket, admin-only IPC).

## Current verified state and observed issues

The packaged executable `release\win-unpacked\DKS.exe` was tested by the user:

Verified:

- The packaged executable opens.
- Login works.
- Typing in grid cells works.
- The Add Column wizard opens.
- Data was observed in Supabase `entries` and `app_columns`.
- Settings opens in the packaged executable.
- The Supabase schema script was applied successfully.

Not yet confirmed end-to-end:

- Every pending outbox item has synchronized.
- Office/Admin RLS boundaries have all been tested.
- Live realtime synchronization between two PCs.
- Every setting persists and synchronizes across PCs.
- Admin delete notification, restore, and permanent delete.
- Export/import/print correctness in the packaged executable.

Reported findings to investigate are detailed in `docs/RESUME_NEXT_SESSION.md`.
Important examples:

- CSV/XLSX export reportedly produced blank files; reproduce in the packaged
  executable before deciding whether it is fixed.
- The packaged app displayed `Sync error · 3 pending`; inspect those pending
  operations and their actual errors. Do not clear the queue or discard local
  changes.
- Permanent delete from Recycle Bin failed with an IPC `ensureOpen` error.
  Do not suppress the error; trace and fix the store/IPC initialization and
  verify whether the record was partially deleted before retrying.
- `npm run dev` started Vite but did not visibly show an Electron window.
  `npx electron .` also showed no window. The packaged executable did work.
  Treat the packaged executable as the primary test target until dev launch is
  fixed.
- A Settings freeze was reported in browser preview, but the user later
  confirmed Settings opens in the packaged executable. Do not report this as a
  confirmed packaged-app failure unless it can be reproduced there.

Browser-preview warning:

- `http://127.0.0.1:5173` opened in a normal browser is not the Electron app.
- It does not provide the Electron preload bridge (`window.dks`) or native
  SQLite.
- Do not treat browser/in-memory preview data as saved app data.
- The UI should identify preview mode clearly and warn that preview data is not
  persisted.
- Persistent/offline/cloud behavior must be tested in the packaged executable
  or a real Electron window.

## Reported build and test results

Use the actual latest results on the current machine; do not assume these
results still apply.

Previously reported:

- `npm ci` completed under Node `v24.21.0`, but the project engine requires
  Node `>=20.19.0 <21`.
- `npm ci` reported 28 audit vulnerabilities, including 4 critical. Review
  before release. Do not run `npm audit fix --force` blindly.
- npm warned that lifecycle scripts for some expected packages were not
  approved. Follow npm’s current instructions and approve only expected
  dependencies needed for Electron, esbuild, and better-sqlite3.
- `npm test`: 33 test files, 126 passed and 5 failed.
- The failing tests include outdated placeholder/workspace assumptions in
  `tests/app-shell.test.tsx` and `tests/sheet-page.test.tsx`. Update the tests
  to reflect the real authenticated flow; do not weaken production auth or
  delete meaningful test coverage just to get a green result.
- `npm run typecheck` passed.
- `npm run build` passed, with Vite deprecation and large-chunk warnings.
- `npm run dist` produced `release\win-unpacked\DKS.exe`, which the user ran
  successfully. The NSIS installer step failed while extracting
  `winCodeSign` because Windows did not permit symbolic-link creation.
  Details and next steps are in `docs/RESUME_NEXT_SESSION.md`.

Native-module commands, only if needed:

```bash
npm rebuild better-sqlite3
npx electron-builder install-app-deps
```

## Required work order

1. Read all three project documents.
2. Inspect git status and recent history. Preserve all current work.
3. Run `npm test`, `npm run typecheck`, and `npm run build`; report actual
   results.
4. Fix non-UI bugs and functional requirements in
   `docs/RESUME_NEXT_SESSION.md`.
5. After the non-UI work is tested, implement the UI requirements in
   `docs/FIXES_UI.md`.
6. Do not reintroduce anything explicitly removed in either requirements
   document.
7. Re-test the packaged executable, RLS, pending sync, installer, and relevant
   user workflows.
8. Finalize README and document release steps. The user performs releases.

## User-only manual actions

The AI agent must not attempt these or request secrets:

- Create `.env` on a new machine; never commit it.
- Run future SQL manually in Supabase SQL Editor if the user approves a
  required migration.
- Confirm whether the two previously exposed Supabase passwords have been
  reset; never request their values.
- Configure optional Resend secrets in Supabase Edge Function secrets if the
  user chooses email notifications.
- Install and test the `.exe` on office PCs.
- Enable Windows notifications for DKS in Windows Settings.
- Set `GH_TOKEN` in a terminal session only when publishing a release.
- Run/publish the final release.

## Packaging and release notes

For Windows packaging:

- Run `npm run build` first.
- Run `npm run dist` to build locally without publishing.
- The previous NSIS build failed because `winCodeSign` extraction required
  symbolic-link privileges. Try an Administrator terminal or Windows Developer
  Mode, as documented in `docs/RESUME_NEXT_SESSION.md`.
- Do not claim the NSIS installer works until a successful installer build
  and install test have been completed.

For releases:

- Public GitHub repo: `tacenta2k/dks`.
- User-only action: bump the package version, set `GH_TOKEN` in the release
  terminal session only, and run the documented release command.
- Never put the token in source, `.env`, GitHub files, or the app binary.

## Working rules for the AI agent

- Work in small, reviewable steps.
- Before editing, inspect the current git state and preserve uncommitted work.
- Do not make unrelated changes.
- Run relevant tests after each implementation step; then run typecheck/build
  before marking a phase complete.
- Commit verified work as requested by the user. Do not silently force-push.
- After each phase, report changed files, test results, and remaining issues,
  then STOP and wait for the user.
- Never ask for passwords, service-role keys, database passwords, connection
  strings, GitHub tokens, or Resend keys.
- Do not add backup features beyond the approved cloud-backup Phase 1 scope
  (encrypt / upload / list / download / test-restore drill), and do not claim
  Docker/Makefile is required for the app. Restore and delete stay out until
  their own phases are approved.
- Do not weaken authentication or authorization to make tests pass.
- Ask the user when a requirement is ambiguous or conflicts with the approved
  documents.