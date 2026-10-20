# DKS Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the available project skills and implement this plan task-by-task with tests and commits.

**Goal:** Build a reproducible Windows Electron desktop app for the DKS Oman medical/visa office that tracks expiry data offline-first, synchronizes through Supabase RLS, and exposes role-appropriate workflows for office and admin users.

**Architecture:** Electron main owns the window, tray, notifications, updater, protected SQLite cache, backup, and sync orchestration. The renderer is a React/TypeScript UI using a contextBridge API only; Supabase is accessed with the publishable key and RLS, while SQLite is the local source of truth for offline edits. Shared domain helpers keep dates, permissions, validation, filtering, and row status deterministic and testable without Electron or network access.

**Tech Stack:** Electron, Vite, React 18, TypeScript strict, AG Grid Community, Supabase JS, better-sqlite3, electron-builder/NSIS, electron-updater, auto-launch, Recharts, date-fns, lucide-react, Zustand, SheetJS, jsPDF/autotable, electron-log, Vitest, React Testing Library.

**Spec:** User-provided DKS buildathon specification in the conversation; the Supabase SQL deliverable is `supabase/schema.sql` and is also printed in the response at STEP 3.

## Global Constraints

- The app is named DKS with app id `com.dks.tracker`, product name `DKS`, and Windows 10/11 as the target.
- No renderer `nodeIntegration`; renderer access to privileged features goes through preload/contextBridge.
- Only Supabase URL and publishable key are client configuration; never include a service-role key, database URL, password, or token.
- Offline changes write SQLite first and are queued for sync; the user must see saved/sync/error state.
- Office users cannot export, print, import, use settings/recycle/audit pages, restore, permanently delete, or change protected expiry settings; backend RLS repeats these rules.
- Days Left uses the primary expiry date with local calendar-day arithmetic and is always the last locked grid column.
- Build reproducibly on clean Linux/Windows using a pinned Node runtime, committed lockfile, Dockerfile, `.env.example`, and one offline-capable `make test` command.
- After every working milestone: run the smallest meaningful check plus the full test command, then commit only intended files.
- Supabase free-tier usage must remain within the stated office size and must not require hosted database extensions beyond the supplied SQL.

## Review Focus

- Local-date calculations around midnight, UTC conversion, leap days, and an empty primary expiry must never shift or display a false day count; owned by `src/lib/date.ts` tests.
- RLS and role checks must deny office access even if the renderer is manipulated; owned by `supabase/schema.sql` policy review and role permission tests.
- Offline edits, duplicate sync deliveries, and last-write-wins conflicts must not silently discard a local edit; owned by SQLite/outbox/sync tests.
- Renderer code must not gain direct Node or secret access through a bundling/import mistake; owned by preload/build smoke checks.
- Import/export and notification paths must degrade cleanly when files, network, updater, or Resend secrets are unavailable; owned by service tests and UI error-state tests.

---

### Task 1: Reproducible Electron/Vite scaffold and STEP 1 shell

**Files:**
- Create: `package.json`, `package-lock.json`, `.nvmrc`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`
- Create: `electron/main/index.ts`, `electron/main/tray.ts`, `electron/main/notifications.ts`, `electron/main/updater.ts`, `electron/preload/index.ts`
- Create: `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`, `src/renderer/components/AppShell.tsx`, `src/renderer/components/LoginPlaceholder.tsx`
- Create: `src/lib/theme.ts`, `src/lib/types.ts`
- Create: `tests/app-shell.test.tsx`, `tests/theme.test.ts`
- Create: `electron-builder.yml`, `.env.example`, `.gitignore`, `Dockerfile`, `Makefile`, `README.md`

**Interfaces:**
- Preload exposes a narrow `window.dks` API with `platform`, `appVersion`, `minimizeToTray`, `quit`, and updater/notification placeholders; no Node globals are exposed.
- `App` renders a login placeholder until STEP 2, then the shell can render dashboard/sheet navigation and theme state.
- `ThemePreference` is `'light' | 'dark' | 'system'`; `resolveTheme(preference, systemDark)` returns the effective theme.

- [ ] Write tests proving `resolveTheme` and the initial shell render (red).
- [ ] Add the minimal Electron/Vite/React configuration and dependencies.
- [ ] Implement secure main/preload/window/tray behavior: close hides the window, tray menu opens Dashboard/Sheet, Logout, and Exit; app starts hidden when auto-launch is enabled.
- [ ] Add light/dark CSS variables, persisted renderer preference, app version, and a visible STEP 1 shell with exact DKS branding.
- [ ] Add a Docker build stage, pinned Node runtime, `.env.example`, builder NSIS metadata, and README setup/run/test/deploy skeleton.
- [ ] Run `npm test`, `npm run typecheck`, and `npm run build`; verify the tests went red before implementation and green after it.
- [ ] Commit `feat: scaffold dks electron app`.

### Task 2: Supabase auth, persisted session, and role gates (STEP 2)

**Files:**
- Create: `src/lib/supabase.ts`, `src/lib/permissions.ts`, `src/lib/store.ts`, `src/features/auth/AuthScreen.tsx`, `src/features/auth/auth-service.ts`, `src/features/auth/auth-types.ts`
- Modify: `src/renderer/App.tsx`, `src/renderer/components/AppShell.tsx`, `electron/preload/index.ts`
- Test: `tests/auth-service.test.ts`, `tests/permissions.test.ts`, `tests/app-auth-flow.test.tsx`

**Interfaces:**
- `AuthService.signIn(email, password)`, `restoreSession()`, `signOut()`, and `loadProfile(userId)` return typed auth/profile results and never log credentials.
- `Role` is `'admin' | 'office'`; `can(role, capability)` is the single renderer permission predicate.
- The store exposes `session`, `profile`, `authStatus`, `syncStatus`, `theme`, and actions for sign-in/sign-out/restore.

- [ ] Write failing tests for successful login, persisted session restore, unauthorized/missing profile sign-out, and role capability boundaries.
- [ ] Implement Supabase client from Vite env values and auth state listener with local session persistence.
- [ ] Implement login screen, top bar email/role badge/logout, and hide admin navigation/actions for office users.
- [ ] Add a Supabase health probe that reports configuration/network/auth errors without crashing.
- [ ] Run full tests/typecheck/build and commit `feat: add supabase authentication and roles`.

### Task 3: SQL schema, RLS, seed data, and health indicator (STEP 3)

**Files:**
- Create: `supabase/schema.sql`, `supabase/edge-functions/expiry-digest/index.ts`, `supabase/README.md`
- Modify: `README.md`, `src/lib/supabase.ts`, `src/features/auth/auth-service.ts`
- Test: `tests/sql-schema.test.ts`, `tests/health-indicator.test.tsx`

**Interfaces:**
- `supabase/schema.sql` is a single executable script with tables, triggers, functions, grants, RLS policies, indexes, bucket, defaults, and exact seed profile UUIDs/emails/roles.
- The health indicator reports `configured`, `reachable`, `authenticated`, and `schemaReady` states without exposing a secret.

- [ ] Write structural SQL tests for required tables/functions/policies/seed values (red).
- [ ] Write the complete SQL and edge-function source; include the same script in the user-facing STEP 3 response inside a fenced block labeled `PASTE INTO SUPABASE SQL EDITOR`.
- [ ] Add verification queries for table counts, role seed rows, and RLS/schema health.
- [ ] Implement health status and the explicit “run SQL in Supabase SQL Editor” onboarding state.
- [ ] Run offline tests and commit `feat: add supabase schema and database health`.
- [ ] Stop at this milestone for the human to run the SQL, while continuing local work that does not require live database state only when explicitly appropriate.

### Task 4: Offline domain model and protected SQLite cache

**Files:**
- Create: `electron/main/sqlite.ts`, `electron/main/sync.ts`, `electron/main/backup.ts`, `src/lib/domain.ts`, `src/lib/date.ts`, `src/lib/validation.ts`, `src/lib/columns.ts`
- Create: `tests/date.test.ts`, `tests/validation.test.ts`, `tests/sqlite-outbox.test.ts`, `tests/columns.test.ts`

**Interfaces:**
- `calculateDaysLeft(isoDate, today)` returns `number | null`; `statusForDays(days, thresholds)` returns status.
- `validateCell(value, column)` returns visual validation diagnostics only.
- SQLite repositories read/write columns, entries, audit, notifications, and an idempotent outbox; encrypted/protected storage is app-owned and never opened as a raw user-facing file.
- Sync uses `updated_at`, idempotency keys, conflict records, and last-write-wins with a visible conflict result.

- [ ] Write red tests for date arithmetic, passport/phone/email/price validation, outbox ordering/idempotency, and column delete rules.
- [ ] Implement schema migrations, repositories, outbox, sync status, backup copy, and close-flush behavior.
- [ ] Run offline full tests and commit `feat: add offline cache and sync foundation`.

### Task 5: AG Grid sheet, column wizard, rows, filters, and renewal (STEP 4/6/10)

**Files:**
- Create: `src/features/sheet/SheetPage.tsx`, `src/features/sheet/grid-columns.ts`, `src/features/sheet/column-wizard.tsx`, `src/features/sheet/row-actions.tsx`, `src/features/sheet/filters.ts`, `src/features/sheet/renew-modal.tsx`
- Create: `src/features/recycle-bin/RecycleBinPage.tsx`, `src/features/audit/AuditLogPage.tsx`, `src/features/notifications/NotificationCenter.tsx`
- Modify: `src/lib/types.ts`, `src/lib/store.ts`, `src/renderer/components/AppShell.tsx`
- Test: `tests/sheet-domain.test.ts`, `tests/column-wizard.test.tsx`, `tests/row-actions.test.tsx`, `tests/renewal.test.ts`

**Interfaces:**
- Grid rows use `{ id, data, category, deleted, updatedAt }` and a derived locked `daysLeft` column.
- Column definitions use the exact stored types and options from the specification.
- Row commands are local-first and emit audit/outbox operations; delete is soft-delete, restore/permanent delete are admin-only.

- [ ] Write red tests for template/empty state, column wizard types, expiry-primary rules, row CRUD/duplicate/delete, days-left rendering, validation warnings, filters/grouping, and renewal snapshot/history.
- [ ] Implement AG Grid Community with keyboard navigation, in-cell editing, search, quick filters, grouping, undo/redo, copy/paste, column visibility/order/resize, and locked Days Left.
- [ ] Add office/admin actions, recycle bin, audit log, admin notification restore/dismiss, and renewal flow.
- [ ] Run tests/typecheck/build and commit `feat: add offline-first visa sheet workflows`.

### Task 6: Dashboard, thresholds, settings, exports, imports, print/PDF (STEP 5/7/8/19)

**Files:**
- Create: `src/features/dashboard/DashboardPage.tsx`, `src/features/settings/SettingsPage.tsx`, `src/features/import-export/import-service.ts`, `src/features/import-export/export-service.ts`, `src/features/print/PrintReportModal.tsx`, `src/features/print/print-service.ts`
- Modify: `src/renderer/components/AppShell.tsx`, `src/lib/store.ts`, `src/lib/domain.ts`
- Test: `tests/dashboard.test.ts`, `tests/settings.test.ts`, `tests/import-export.test.ts`, `tests/print-report.test.ts`

**Interfaces:**
- Dashboard selectors produce the eight cards, status pie data, and next-12-month bar data from the same domain status function as the grid.
- Export/import services accept current filtered rows and explicit column selections; office permissions reject admin-only calls at both UI/service layers.
- Print report models contain header, generated time, filter summary, columns, sorted rows, and page metadata.

- [ ] Write red tests for threshold/color updates, currency formatting, dashboard counts, admin-only exports/imports, mapping/preview, and report filters.
- [ ] Implement Recharts dashboard, admin settings, CSV/XLSX export/import, print CSS/PDF, backup, and update settings UI.
- [ ] Run tests/typecheck/build and commit `feat: add dashboards reports and admin tools`.

### Task 7: Notifications, tray alerts, summaries, updater, and auto-launch (STEP 9/21)

**Files:**
- Modify: `electron/main/notifications.ts`, `electron/main/tray.ts`, `electron/main/updater.ts`, `electron/main/index.ts`
- Create: `src/features/notifications/alert-service.ts`, `src/features/notifications/NotificationBell.tsx`
- Modify: `src/features/settings/SettingsPage.tsx`, `README.md`
- Test: `tests/notifications.test.ts`, `tests/updater.test.ts`

**Interfaces:**
- Alert evaluation accepts rows, current local time, thresholds, configured alert days, snoozes, and dismissed expiry values; it returns deterministic notifications.
- Main process schedules hourly checks and daily/weekly summaries, catches OS/network errors, and never includes secrets in logs.
- Updater is quiet on no release/network error, downloads in background, and exposes “restart to update” state.

- [ ] Write red tests for alert days, snooze/dismiss, daily/weekly summary selection, tray urgent counts, and updater no-release failure handling.
- [ ] Implement Windows notifications, notification center actions, tray badge/tooltip, auto-launch, and electron-updater GitHub configuration.
- [ ] Add optional Resend Edge Function deployment instructions without storing its key in the app.
- [ ] Run tests/typecheck/build and commit `feat: add alerts tray and updates`.

### Task 8: Final reproducibility, packaging, documentation, and release checks

**Files:**
- Modify: `README.md`, `Makefile`, `Dockerfile`, `electron-builder.yml`, `package.json`
- Create: `docs/test-checklist.md`, `docs/release.md`

- [ ] Add exact install/run/test/dist/release steps, GH_TOKEN temporary usage, SmartScreen/troubleshooting, SQL setup, free-tier notes, and the complete office/admin checklist.
- [ ] Ensure `npm run dev`, `npm run build`, `npm run dist`, and `make test` are deterministic with the committed lockfile and pinned runtime.
- [ ] Run the complete test command, typecheck, production build, and (where Windows tooling is available) installer build; record any environment-limited check honestly.
- [ ] Inspect git status/diff and commit `chore: finalize dks release documentation`.

## Final Verification

- `make test` passes offline after dependencies are installed.
- `npm run typecheck` passes with strict TypeScript.
- `npm run build` creates the renderer/main bundles without Node leakage into the renderer.
- `npm run dist` produces an NSIS installer on Windows with app id/product name `com.dks.tracker`/`DKS`.
- Supabase SQL has been run by a human and the health indicator reports schema ready before cloud sync is considered verified.
- Manual checklist covers both roles, offline edits, sync, notifications, reporting, security boundaries, restore/permanent delete, renewal history, backup, and updater behavior.
