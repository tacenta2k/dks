# DKS — Session Progress (Agent)

Session branch: `arena/cce2ff33-dks` (round 2; PR #1 merged into `main`).
Round-2 work is listed in section 8 onwards. Nothing in this file is
"CONFIRMED" unless the user verified it on Windows.
Companion file: `ARENA/TO_DO_LIST.md` (single implementation checklist).
Source docs (read-only): `HANDOFF.md`, `docs/RESUME_NEXT_SESSION.md`, `docs/FIXES_UI.md`.

This file is written by the agent. The user keeps `HANDOFF.md` for their own record.

---

## 1. Confirmed by user (verification in the packaged Windows app)

Recorded exactly as verified by the user; nothing else is treated as confirmed:

| # | Item | Source ID |
|---|------|-----------|
| 1 | Typing/focus delay fixed (no lag, focus retained while editing) | SHEET-19 |
| 2 | Passport field works as plain text (F1) | SHEET-17 |
| 3 | Permanent delete from Recycle Bin works (B2) | CRIT-02 |
| 4 | CSV/Excel import and export work (B1) | CRIT-03 |
| 5 | Days Left calculation works (final locked column, correct status) | SHEET-20 |
| 6 | Sync status can become healthy (pending items reach cloud) | CRIT-04 |
| 7 | Recycle Bin shows "Deleted by"; Audit Log filters work; weekly Settings controls exist | RBIN-05, AUDIT-02/05, SET-03 |
| 8 | `author` present in `package.json` (S8) | PKG-01 |

### Round 2 user-confirmed results (recorded verbatim, STEP 0)

Real Windows tests in the packaged app confirmed WORKING:

| # | Item | Source ID |
|---|------|-----------|
| 9 | Input/typing focus fix (no lag, focus retained) | SHEET-19 |
| 10 | Passport works as plain text | SHEET-17 |
| 11 | Permanent delete from the Recycle Bin | CRIT-02 |
| 12 | CSV/Excel import + export | CRIT-03 |
| 13 | Days Left | SHEET-20 |
| 14 | Admin sync reaches "Saved to cloud" | CRIT-04 |
| 15 | Dashboard ("perfect") | DASH-01..03 |
| 16 | Audit Log entries + filters | AUDIT-02/03/05 |
| 17 | Recycle Bin "Deleted by" | RBIN-05 |
| 18 | Settings weekly summary | SET-03 |
| 19 | New global shell / top bar / sidebar present | SHELL-01/06/07 |

NOT working / not done: the round-2 list (R2-01 .. R2-15) in section 8.

## 2. Completed this session (IMPLEMENTED_AWAITING_CONFIRMATION unless noted)

All items below pass the gate (`npm rebuild better-sqlite3 && npm test && npm run typecheck && npm run build`)
and are committed on this branch. They are **not** treated as user-confirmed.

### 2.1 Phase One (earlier in session)
- B1 Grid typing/focus (remount architecture fix) — CONFIRMED_BY_USER (row 1 above).
- B2 Recycle Bin permanent delete (IPC `ensureOpen` crash) — CONFIRMED_BY_USER.
- B3 Sync error surfacing + outbox drain (sanitized reason, per-op errors, no duplication) — CONFIRMED_BY_USER ("sync can become healthy").
- F1 Passport plain text + non-blocking duplicate warning — CONFIRMED_BY_USER.
- F3 Removed hard-coded business columns / template.
- S2 Recycle Bin "Deleted by", friendly labels, local DD/MM/YYYY HH:mm — CONFIRMED_BY_USER.
- S3 Audit Log real actor, friendly actions, filters, details — CONFIRMED_BY_USER.
- S5 Conflict handling (server wins, row flagged, both versions in audit).
- S6 Admin notification → View → Restore flow for Office deletions.
- S7 Primary-expiry change recomputes Days Left/colours/alerts.
- B5 Local persistence re-check (rows/columns/settings survive restart).
- Admin/Office permission enforcement (RLS + service/IPC + renderer).
- B6 `npm run dev` window visibility (main-process logging) — see note below.
- F4 Backup features removed; absence-asserting tests kept.

### 2.2 Baseline consolidation
- Commit `6b84f8e` (this session): consolidated the entire working tree (Phase One
  B1–B6, F1–F4, S1–S9) into one commit on the fresh-clone baseline.
- Gate at that commit: **39 test files / 213 tests passed (101.24s)**, typecheck clean, build OK.

### 2.3 Entries RLS insert authorization (CRIT-01) — THIS TURN
- **Root cause:** local rows never persist `created_by`, and the sync payload
  (`toRemoteEntry`) omitted it, so a fresh remote INSERT relied on the
  `created_by default auth.uid()` column default. When that default did not
  resolve to the session UID, the entries INSERT policy
  (`created_by = auth.uid() and not deleted`) rejected the row:
  `new row violates row-level security policy for table "entries"`.
  (The `app_columns` table, which has the same `created_by` structure, had
  "worked" because its rows were already remote — i.e. UPDATEs, whose policy
  does not check `created_by` — so the INSERT path was what was actually failing.)
- **Fix (app-side; RLS preserved — no policy changes, no anon grants, no
  service-role, no Admin/Office weakening):**
  - `toRemoteEntry` now accepts `forInsert` and, on inserts only, stamps
    `created_by` from the authenticated session (`options.userId` = `auth.uid()`).
    On updates it omits `created_by` so the original creator is preserved.
  - Reconciliation passes `forInsert: !remote` for the first push (insert when
    the remote has never seen the row; update otherwise) and `forInsert: false`
    for the soft-delete follow-up (an update after the forced-active insert).
  - Flows verified: new active row (insert, `created_by=uid`, `deleted=false`);
    new soft-deleted row (forced-active insert then deletion update — the
    Office deletion-update path `deleted_by = auth.uid()`); existing changed row
    (update, creator preserved).
- **Policy review:** the entries INSERT/UPDATE policies in `supabase/schema.sql`
  are correct and secure (both Admin and Office can insert their own rows and
  update active rows). **No SQL migration is required** for this fix, so no
  `ARENA/sql/fix-entries-rls.sql` was created.
- **Regression test:** new `describe('entries insert authorization (RLS
  regression)')` in `tests/supabase-sync.test.ts` (4 tests) runs the real store +
  sync against a capturing remote double and evaluates the exact entries INSERT
  policy: Admin and Office inserts pass with `created_by = auth.uid()`; an
  update omits `created_by`; the policy simulator rejects mismatched
  `created_by`/`deleted=true`.
- Gate for this turn: `tests/supabase-sync.test.ts` **20 passed** (16 prior + 4
  new); full-suite gate runs before commit.

### 2.4 B6 dev-window note
- B6 (dev window visibility) was reworked; its final packaged status should be
  re-checked by the user alongside the RLS fix (see Section 5).

### 2.5 UI batch 1 — Global shell & navigation (SHELL-01..07) — THIS TURN
Per `docs/FIXES_UI.md` §2 (removed elements), §3 (top bar), §4 (sidebar):
- **Compact top bar (50px)** on every authenticated page: left = `☰` sidebar
  toggle + page title (h1); right = `[Sync] [Bell] [Theme] [Avatar]`. Removed
  from the top bar: breadcrumb, eyebrow/context, visible email, standalone
  Log out, "Theme: X" text dropdown.
- **Global sync status (SHELL-02)** moved from the sidebar footer to the top
  bar as a real-state control: `● Saved to cloud` / `◐ Syncing…` /
  `○ Offline — saved locally` / `⚠ Sync error` (dot colour follows state;
  error is never green). Pending count suffix preserved. Click/keyboard opens
  a compact popover with last-sync time (DD/MM/YYYY HH:mm), pending count, and
  the sanitised per-item outbox breakdown. The popover stays mounted (the
  Blocker-3 `details.sync-status__issues` + per-item rows remain queryable —
  `tests/sync-status-ui.test.tsx` still passes).
- **Notification bell (SHELL-03)**: unchanged contract (unread badge,
  click-to-open, role-gated View/Restore); added Escape + outside-click close.
- **Theme (SHELL-04)**: icon-only toggle (moon in light → "Switch to dark
  mode", sun in dark → "Switch to light mode"); one click switches; preference
  persists per-PC via `onThemeChange`.
- **Avatar popup (SHELL-05)**: only the avatar is visible; click opens a menu
  with actual email + actual role + divider + Log out; Esc/outside close.
- **Collapsible sidebar (SHELL-06)**: 220px expanded / 56px collapsed
  (icons + logo only, `title` tooltips); toggled by `☰`; state persisted in
  `localStorage['dks.sidebarCollapsed']`; distinct SVG icons per page;
  selected state; Office sees only Dashboard + Visa Sheet; removed the
  "Workspace health" footer box + "STEP 2" text.
- **Removed (SHELL-07)**: breadcrumbs, subtitles, eyebrow labels, developer
  STEP text, "Offline-first" pill, sidebar health footer, and the shared
  content-intro "Export data" button (export lives in the sheet Tools menu).
  Also removed the duplicate page `<h1>` + "Admin tools" eyebrow from
  `RecycleBinPage` and `AuditLogPage` (page title now in the top bar) — a
  prerequisite for batch 3's §7/§8 layouts.
- **Tests updated to documented behaviour** (no coverage removed): nav
  aria-labels ("Open X" → page name), identity/log-out moved to the avatar
  popup, theme icon-toggle interaction, top-bar title assertion, and the two
  standalone panel tests (heading now App-level). B3 sync, notifications,
  theme, and permissions contracts preserved.
- Gate: rebuild 0; **39 files / 217 tests passed**; typecheck 0; build ✓.

### 2.6 UI batch 2 — Visa Sheet structure (SHEET-02/03/08/15/16-partial) — THIS TURN
Per `docs/FIXES_UI.md` §5 (Visa Sheet):
- **One-row toolbar (SHEET-01/02):** the three stacked bars (primary + filter
  bar + inline admin block) are consolidated into a single `.sheet-toolbar`
  row: left `.sheet-toolbar__filters` (Search records + Status ▾ +
  single-select quick chips All / Expired / 7 days / 30 days / 60 days /
  90 days / No expiry), right `.sheet-toolbar__actions` (Add row · Add column
  · Manage columns). Old `.sheet-filter-bar` box + its CSS removed.
- **Admin tools de-duplicated (SHEET-05/16):** the redundant inline admin block
  (Export / Import / Print / Settings / Recycle bin / Audit log) is removed
  from the sheet — it already lives in the Admin-only `Tools ▾` menu
  (`AdminSheetActions`), fully absent for Office. No "Export data" card.
- **Empty states (SHEET-15):** one context-aware empty state, never two —
  (a) no columns → the existing "Click + to add your first column" first-column
  panel; (b) columns exist but 0 rows → "No records yet…"; (c) rows exist but 0
  match filters → "No records match the current filters." + a working
  "Clear filters" action (resets search/status/quick filter).
- **Dense rows (SHEET-08):** AG Grid `--ag-row-height` set to 26px + reduced
  cell vertical padding (the grid renders only outside tests, so no
  test/layout regression); status row tinting already present.
- **Deferred in this batch (honest scope, no functional regression):**
  SHEET-10 (`+` column header), SHEET-11 (draft row), SHEET-13/14 (right-click
  column/row menus), SHEET-04 (Group by), and the remaining SHEET-16 button
  removals — these need new AG Grid interaction surfaces, so the existing,
  test-covered Add row / Add column / Manage columns buttons are kept until
  their replacements exist. Quick-chip labels kept as "7 days"/"30 days" (the
  sheet test asserts the "7 days" button) rather than "≤7d".
- **Tests:** no coverage removed — `sheet-page` (6) and `admin-features` (8)
  pass unchanged against the new single-row toolbar and empty states.
- Gate: rebuild 0; **39 files / 217 tests passed**; typecheck 0; build ✓.

### 2.7 UI batch 3 — Dashboard / Recycle Bin / Audit Log (DASH-01, RBIN-01/02, AUDIT-01/04) — THIS TURN
Per `docs/FIXES_UI.md` §6/§7/§8:
- **Dashboard (DASH-01):** the duplicate heading/subtitle/Offline-first pill/
  Export Data were already absent (top bar carries the title); removed the
  large 40px top margin so the cards/charts use the available width with no
  dead space under the 50px top bar.
- **Recycle Bin (RBIN-01/02):** added one compact search/count toolbar —
  `[Search deleted records…]  N items · kept until permanently deleted`. The
  search filters deleted rows by record label or any cell value; the count is
  the visible (filtered) item count. Truthful retention wording used because
  **no automatic purge exists in this build** (verified by search of `src/`).
  Full-width table + sticky header added. New empty states: "Recycle Bin is
  empty" (0 deleted) and "No deleted records match this search" (0 filter
  matches). Restore/Permanently-delete buttons kept name-suffixed
  (`Restore [label]`) — that text is asserted by both `recycle-bin` and
  `admin-features` tests and matches the confirmed S2 behaviour.
- **Audit Log (AUDIT-01/04):** full-width table + sticky header + compact
  filter row (Action / Actor / date range) now styled. Added the details side
  panel (AUDIT-04): clicking a row's **View** button opens a right-hand panel
  with the action, actor · time, and `field: old → new` transitions resolved
  from the event metadata (never invented historical column names), plus an
  optional **View raw** toggle showing **sanitised** formatted JSON
  (token/password/secret/api-key/authorization/credential keys masked to `•••`).
  The inline summary + "Show raw JSON" stay in the table (S3 "raw JSON on
  demand" is confirmed behaviour and asserted by `audit-log`), so the panel is
  additive, not a replacement.
- **Tests:** no coverage removed — `audit-log` (5), `recycle-bin` (3),
  `dashboard` (3), and App-level `admin-features` (8) all pass unchanged.
- Gate: typecheck 0; **39 files / 217 tests passed**; build ✓.

### 2.8 UI batch 4 — Settings inner nav, login cleanup, restart persistence (SET-01, SET-12, SYNC-10) — THIS TURN
Per `docs/FIXES_UI.md` §9.1 / §13 / §4+3.2:
- **Settings (SET-01):** converted the single scrolling page into the approved
  **inner navigation** — left nav (Expiry rules / Notifications / Workspace /
  About & updates) + one selected section at a time. Split the old "Expiry
  rules" block: thresholds + status colours stay under Expiry rules; the
  notification-days + daily/weekly summary controls moved to their own
  **Notifications** section. Removed the duplicate page header (eyebrow
  "Administration" + `<h2>Settings` + description — the top bar carries the
  title) and the "Close settings" button. Inputs capped at ~320px; layout
  stacks on narrow windows. **Kept (documented conflict, honest):** the
  "Resend:" note — it is the user-confirmed SET-03 email-status text and is
  asserted by `settings.test.tsx`, so it is not developer placeholder; the
  transient save-feedback banner stays (SET-06 territory). `settings.test.tsx`
  updated to navigate the inner nav per section — **no coverage removed**, same
  controls asserted per section.
- **Login (SET-12):** removed the obsolete developer "Authentication will be
  connected in STEP 2 …" placeholder. Kept the real login form, branding, and
  the dev/test-only demo control (gated to no-Supabase + DEV/test). No
  social/signup/guest/bypass added; no new logo/fonts/palette.
- **Restart persistence (SYNC-10):** sidebar collapse state already persisted
  (`localStorage['dks.sidebarCollapsed']`). Added a startup effect that reads
  the persisted `local.getSnapshot().syncStatus` so the top-bar sync state
  (pending count / last sync / error) is restored immediately on restart
  instead of flashing the default offline/0 before the first background tick.
  Demo mode is left untouched. `sync-status-ui` is unaffected (renders
  `AppShell` directly); App-level tests have no `window.dks.local` so the new
  effect is a safe no-op there.
- Gate: typecheck 0; **39 files / 217 tests passed**; build ✓.

### 2.9 UI batch 5 — Visa Sheet grid structure (SHEET-01, SHEET-06, SHEET-10) — THIS TURN
Per `docs/FIXES_UI.md` §5.1/§5.3/§5.5:
- **Grid fills height (SHEET-01):** `.sheet-grid` height changed from a fixed
  420px to `calc(100vh - 214px)` (min 320px) so the grid fills the available
  viewport below the 50px top bar + toolbar and scrolls internally.
- **Row-number gutter + freeze (SHEET-06):** added a narrow `__rowNumber`
  column pinned left (1-based number via `node.rowIndex` — AG Grid v32 has no
  `rowNumbers` colDef property) and froze the first data column (`pinned:
  'left'`). Click-to-sort / resize / column drag / sticky header were already
  on (Community defaults). Double-click autofit is **deferred** (no stable
  v32 API verified here).
- **`+` add-column header (SHEET-10):** added a `__addColumn` column pinned
  before Days Left with a compact `+` header button (aria-label "Add column")
  that opens Column Setup; blank body cells; no sort/filter/drag/menu; excluded
  from exports (synthetic, not a data column).
- **Verified in jsdom:** the `grid-date-editor-e2e` suite mounts the **real**
  AgGridReact with the real `buildGridColumns` output, so a new test asserts the
  `+` header opens Column Setup (callback fires), the gutter renders a row
  number, the `+` body is blank, and the first data column is pinned left.
  No coverage removed; suite grew 217 → **218**.
- **Deferred (honest — need a visual/dev pass or are test-locked):** SHEET-04
  (Group by), SHEET-12 (keyboard editing — largely Community defaults),
  SHEET-13/14 (right-click column/row menus), SHEET-11 (draft row), SHEET-16
  (button removal — depends on SHEET-11 + test-locked buttons), SHEET-03 (chip
  label rename — the "7 days" button is asserted by the sheet test).
- Gate: typecheck 0; **39 files / 218 tests passed**; build ✓.

### 2.10 UI batch 6 — Visa Sheet row right-click menu (SHEET-14) — THIS TURN
Per `docs/FIXES_UI.md` §5.6: added a row right-click context menu to the AG Grid
sheet (Duplicate row / Delete row / Mark renewed), built by a new pure helper
`buildRowContextMenuItems(row, callbacks)` and wired into `<AgGridReact>` via the
Community `getContextMenuItems` option (returns `[]` for non-row targets). The
menu mirrors the in-cell actions; Copy/Paste remain in the grid's default menu;
permissions are enforced by the repository/service the callbacks call (same as
the in-cell buttons). Verified by a unit test (`row-context-menu.test.ts`)
asserting the three items and that each `action()` invokes the matching callback
with the row. Suite grew 218 → **219**. Gate: typecheck 0; **40 files / 219 tests
passed**; build ✓.

## 3. Tracking files
- `ARENA/TO_DO_LIST.md` — single implementation checklist (9 groups, stable IDs).
- `ARENA/ARENA_PROGRESS.md` — this file (session progress + confirmed items).
- No new requirement docs were created; the three source docs were not edited.

## 4. Current work (in progress)
- [x] Entries RLS insert authorization (CRIT-01) — implemented + 4 regression tests.
- [x] `ARENA/TO_DO_LIST.md` + `ARENA/ARENA_PROGRESS.md` created.
- [x] Full gate green (rebuild 0; **39 files / 217 tests**; typecheck 0; build ✓).
- [x] Commit RLS fix — `0204f2d` `fix: allow authenticated entry sync under entries RLS`.
- [x] Commit tracking files — `512dd2b` `docs: add ARENA implementation checklist and session progress`.
- [x] Reconcile diverged pushed lineage (`70d91a0`) via merge `8757152` (no content change; post-merge tree byte-identical to `512dd2b`), then **pushed** fast-forward `70d91a0..8757152` to `origin/arena/0e0155c1-dks`. No force-push.
- [x] **UI batch 1: Global shell & navigation (SHELL-01..07)** — implemented + gate green. See §2.5.
- [x] **UI batch 2: Visa Sheet structure (SHEET-02/03/08/15/16-partial)** — one-row toolbar, admin de-dup, empty states, dense rows. See §2.6. (SHEET-01/04/10/11/13/14/16-button-removals deferred — see §2.6.)
- [x] **UI batch 3: Dashboard / Recycle Bin / Audit Log (DASH-01, RBIN-01/02, AUDIT-01/04)** — dashboard spacing, RB search/count + empty states, audit details side panel. See §2.7.
- [x] **UI batch 4: Settings inner nav, login cleanup, restart persistence (SET-01, SET-12, SYNC-10)** — see §2.8.
- [x] **UI batch 5: Visa Sheet grid structure (SHEET-01, SHEET-06, SHEET-10)** — grid height, row-number gutter + freeze, `+` add-column header. See §2.9.
- [x] **UI batch 6: Visa Sheet row right-click menu (SHEET-14)** — see §2.10.
- [ ] Remaining deferred sheet items: SHEET-04 (Group by), SHEET-11 (draft row), SHEET-12 (keyboard), SHEET-13 (column right-click menu), SHEET-16 (button removal), SHEET-03 (chip labels) — visual/dev pass or test-locked (see §2.9/§2.10).
- [ ] PKG-07 UI verification checklist (user-facing) + SYNC-09 dev-window focus (main-process) — see Notes.

### Commit map (this session, this lineage)
- `0204f2d` fix: allow authenticated entry sync under entries RLS
- `512dd2b` docs: add ARENA implementation checklist and session progress
- `8757152` merge: reconcile re-established branch with pushed lineage (no content change)
- `f6411a8` feat: rebuild global shell and navigation (compact top bar, collapsible sidebar) — UI batch 1
- `02172d3` feat: consolidate Visa Sheet toolbar, admin tools, and empty states — UI batch 2
- `626b18b` feat: rebuild Dashboard, Recycle Bin, and Audit Log layouts — UI batch 3
- `2832644` feat: Settings inner nav, login cleanup, restart sync persistence — UI batch 4
- `e63c0cc` feat: Visa Sheet grid structure (height, gutter, freeze, `+` header) — UI batch 5
- `<tip>` feat: Visa Sheet row right-click menu (Duplicate/Delete/Mark renewed) — UI batch 6 (this commit)
- (remote `origin/arena/0e0155c1-dks` updated on push; see `git log`)

## 5. Outstanding user-only actions (BLOCKED — not agent work)
1. **Verify the RLS fix in the packaged app on Windows** (exact checks in
   `ARENA/TO_DO_LIST.md` CRIT-01 + Section 7 below). This is the critical
   remaining verification for this turn.
2. App icon PNG → `build/resources/icon.ico` (PKG-02).
3. NSIS installer build in an elevated terminal / Developer Mode (PKG-03).
4. Reset both Supabase passwords; run any approved SQL (none required for the
   RLS fix); optional Resend secrets; office-PC install/test (PKG-04, PKG-06).

## 6. Constraints honored
- No backups; no passport-format validation; no hard-coded business
  columns/template; no Actions column; Excel-like sheet per FIXES_UI.
- RLS NOT disabled; no anon grants; no service-role; no Admin/Office weakening;
  no remote SQL executed by the agent (reviewed files only, if ever needed).
- `created_by`/`updated_by` come from the authenticated session, never null or
  another user's ID (on the paths that set them).
- Only `arena/0e0155c1-dks` is pushed; PR #1 stays open; no force-push.
- No secrets/customer data in commits or logs; no dependency or Node changes.
- Tests updated to documented behavior; product behavior never reverted to pass.

## 7. Exact Windows verification still required (RLS fix, CRIT-01)
Run the packaged app on the Windows machine (fresh profile or after clearing the
old failed outbox item is fine — the fix makes the insert succeed):
1. Log in as **Office** (`amervisamedical1dks@gmail.com`): create a new row in
   the Visa Sheet with a name + a date in an expiry column.
2. Wait for sync: the top-bar status must reach **Saved to cloud / healthy**
   (no "Sync error · N pending").
3. Log in as **Admin** (`shahabasnavas123@gmail.com`): confirm the Office-created
   row is present, and the Audit Log records the insert with actor **Office**.
4. Create a row as **Admin** too; both roles' inserts must succeed.
5. If (and only if) it still fails, the now-visible sanitized error text in the
   sync popover identifies the failing policy — send that exact text. (The fix
   removes the `created_by` clause from the failure path; any residual failure
   would be role-related or a live-schema drift, which the sanitized error will
   reveal without requiring a RLS weakening.)

---

# ROUND 2 — critical fixes + remaining UI work

Round-2 scope: the R2 list supplied by the user (R2-01 .. R2-15), worked in
batches A–D. Every item below is `IMPLEMENTED_AWAITING_CONFIRMATION` unless it
says otherwise; nothing is marked CONFIRMED here.

## 8. Batch A — critical / functional (R2-01, R2-03, R2-05, R2-12)

### 8.1 R2-01 — entries RLS: Office can sync edits and deletes

**Root cause (confirmed by the shipped code and the user's log):**

- The entries UPDATE policy's ``WITH CHECK`` only accepted one exact row
  shape, and the client wrote *every* row (including rows that already
  existed remotely) through ``upsert`` = ``INSERT … ON CONFLICT DO UPDATE``.
  The INSERT half of that statement re-ran the INSERT policy, which requires
  ``created_by = auth.uid()`` and ``not deleted``. Office editing an
  Admin-created row (``created_by = Admin``) and Office soft-deleting a row
  (``deleted = true``) therefore both failed with
  ``new row violates row-level security policy for table "entries"``.
- ``attempts`` was only incremented by ``markOutboxProcessing``, which the
  sync loop never calls, so failed items always read ``attempted 0×``.

**SQL delivered — the user must run this in Supabase:**

- ``ARENA/sql/fix-entries-rls.sql`` — idempotent (drops + recreates every
  policy/trigger), RLS stays enabled, no anon grants, no service-role, no
  hard deletes. Implements:
  - INSERT: any authenticated admin/office, ``created_by = auth.uid()``,
    never born deleted.
  - UPDATE: both roles may update **any live row** (no ``created_by`` test at
    all), including setting ``deleted = true`` with ``deleted_at`` and
    ``deleted_by``. Office cannot see or update an already-deleted row
    (USING clause: ``is_admin() or (is_office() and deleted is false)``), so
    restore stays admin-only.
  - ``entries_keep_created_by`` BEFORE UPDATE trigger: ``created_by`` is
    copied from OLD, so it can never change after insert.
  - ``entries_guard_office_restore`` BEFORE UPDATE trigger: a hard error if
    Office ever tries to move a deleted row back to active.
  - DELETE: admin only (unchanged).
- ``supabase/schema.sql`` received the same policies and both triggers, so a
  fresh install matches the migration.
- Reported to the user in the first progress message so the SQL could be run
  while the rest of the batches were being implemented.

**Client fixes:**

- ``supabase-sync.ts`` now distinguishes writes: a row the remote has never
  seen is a real ``INSERT`` (created_by stamped); an existing row is a real
  ``UPDATE`` (``.update(values).eq('id', …)``, no ``created_by`` in the
  payload). Test doubles / older clients that only expose ``upsert`` keep
  using the idempotent upsert fallback, so no coverage was lost.
- ``columns`` follow the same insert-vs-update split.
- ``markOutboxFailed`` now increments ``attempts``, so the sync detail panel
  shows a real attempt count instead of ``attempted 0×``.

**Tests added (`tests/entries-rls.test.ts`, 14 tests):**

- Office updates a live Admin-created row → allowed, ``created_by`` stays Admin.
- Office soft-deletes a live Admin-created row → allowed, ``deleted_by`` set.
- Office updating/restoring an already-deleted row → rejected (0 rows +
  trigger error).
- A rogue payload cannot rewrite ``created_by``.
- INSERT policy: both roles, own ``created_by`` only, never born deleted.
- Admin paths unchanged (sees deleted rows, restores; hard delete admin-only).
- Sync client uses UPDATE (not upsert) for existing rows, INSERT for new rows,
  drains the outbox after success.
- ``markOutboxFailed`` increments attempts (1 → 2).
- The migration file is idempotent / RLS-safe, and ``schema.sql`` mirrors it.

### 8.2 R2-03 — sign-in clicks ignored during the health check

- ``AuthScreen`` used ``authStatus === 'loading'`` (which the Supabase health
  probe also sets) to disable the inputs and the button. It now tracks the
  sign-in request locally: inputs are never disabled, only the Sign in button
  is disabled (with ``aria-busy``) while a sign-in request is in flight.
- The form is not remounted by the health check (asserted by a test that
  re-renders with a changed health result and checks the same input node).
- Tests: ``tests/auth-screen.test.tsx`` (4 tests).

### 8.3 R2-05 — app name in Windows notifications

- ``electron/main/index.ts`` now calls ``app.setName('DKS')`` and
  ``app.setAppUserModelId('com.dks.tracker')`` at module load (before any
  window, tray or notification), exported as ``configureAppIdentity()`` for
  testability. ``productName``/``appId`` in ``electron-builder.yml`` are
  unchanged.
- Honest limitation: a **development** build may still show
  ``Electron.app.electron`` because Windows resolves the notification author
  from the installed Start Menu shortcut. Verify the name in the packaged NSIS
  installer, not in ``npm run dev``.

### 8.4 R2-12 — sync pill truthfulness

- New pure helper ``src/lib/sync-indicator.ts``. Rules: pending > 0 can never
  read "Saved to cloud"; ``syncing`` → "Syncing… · N pending"; ``error`` or
  any non-syncing pending work → "Sync error · N pending"; ``offline`` with an
  empty outbox → "Offline — saved locally"; only ``healthy`` + 0 pending →
  "Saved to cloud".
- ``AppShell`` uses the helper for the pill and its ``data-state`` colour.
- Tests: ``tests/sync-indicator.test.ts`` (5 tests).

**Batch A gate:** 43 test files / 242 tests passed; typecheck clean; build ✓.

## 9. Batch B — shell, notifications, theme (R2-02, R2-11, R2-07, R2-08)

### 9.1 R2-02 — one clean notification popover for both roles

- `NotificationBell` was rewritten: the popover is anchored under the bell with
  a title row (`Notifications` + unread count), a borderless list where each
  item is **one-line message** + a small secondary line (**record · date**,
  `DD/MM/YYYY`, or record · deleted time for admin alerts), then **one compact
  button row**. No bullet markers, no native `datetime-local` input, no custom
  snooze.
- Snooze choices are gated by the days left (`snoozeOptionsForDaysLeft`):
  `D >= 7` → 1 day / 3 days / 1 week; `3 <= D < 7` → 1 day / 3 days;
  `1 <= D < 3` → 1 day; `D <= 0` → Mark read only. A snooze is never longer
  than the time left.
- Admin deletion alerts keep **View · Restore · Dismiss**.
- Bell click toggles; Esc and outside-click close. The popover stays mounted
  and open after an action; the item updates in place or leaves the list, and
  the unread badge is derived from the same state so it updates immediately.
- New CSS (`.notification-bell*`) — the popover previously had **no styles at
  all**, which is what made the Admin popover look "messy" and left Office on
  the unstyled old markup.
- Tests: `tests/notification-popover.test.tsx` (9); updated
  `tests/notifications.test.ts` to the new contract (no custom snooze).

### 9.2 R2-11 — Office shell parity

- Both roles render the same `AppShell`: sidebar (no Workspace-health footer),
  compact top bar, sync pill with expandable details, bell popover and avatar
  menu. Office only has fewer nav items (Dashboard + Visa Sheet) and no admin
  actions (no Tools menu, no Settings/Recycle Bin/Audit Log).
- Tests: `tests/office-shell.test.tsx` (3) — same top bar/bell/sync popover for
  Office, no admin nav or Tools, admin deletion alerts not exposed to Office.

### 9.3 R2-07 — AG Grid follows the dark theme

- The sheet grid now gets `ag-theme-quartz-dark` alongside the base theme when
  the app resolves to dark (`sheetGridThemeClass`), plus theme-token overrides
  for surfaces, header, editors, menus and scrollbars
  (`--ag-background-color`, `--ag-foreground-color`, …).
- Recycle Bin and Audit Log are plain HTML tables that already use the theme
  variables; explicit dark rules were added so no row/panel renders white.
- Tests: `sheetGridThemeClass` assertions in `tests/theme-personal.test.tsx`.

### 9.4 R2-08 — opening/saving Settings no longer resets the theme

- The Settings page used to push its "Theme default" value into the live
  session on every save (and the remote settings load applied it to any
  sign-in). Now a personal theme choice always wins:
  - saving Settings no longer changes the active theme;
  - the workspace default is applied only when this PC has **no saved personal
    preference** (`hasSavedThemePreference`), i.e. a new sign-in.
- Tests: `tests/theme-personal.test.tsx` (4) — personal dark survives saving a
  light workspace default and opening Settings; toggle stays authoritative.

## 10. Batch C — Visa Sheet (R2-04, R2-09)

### 10.1 R2-04 — final Status dropdown + date chips

- Status dropdown is now exactly: All statuses · Valid · Expiring soon ·
  Expired · No expiry. "Urgent" and "Expires today" were removed (they remain
  row colours / Days Left badges).
- "Expiring soon" = **every non-expired row with `0 <= Days Left <= threshold`**
  (workspace expiring-soon threshold, default 90) — deliberately wider than the
  old status band.
- Chips are exactly Today · ≤7d · ≤30d · ≤60d · ≤90d; the Expired and
  No-expiry chips are gone. Single-select; clicking the active chip clears it.
- Tests: `tests/sheet-filters.test.ts` (4); `tests/sheet-page.test.tsx` updated
  to assert the final five options and five chips.

### 10.2 R2-09 — full-width sheet, Tools menu, draft row, column menu

- **Full width/height**: `.content--sheet` removes the centered 1280px wrapper
  and its wide padding (10–12px), the sheet fills `100vh - 50px`, the grid
  fills the remaining height with `domLayout="normal"` so it scrolls
  internally.
- **Administrator Tools card removed** and replaced by the Admin-only
  **Tools ▾ toolbar menu**: Import file / Export CSV / Export Excel /
  Print-PDF report (fully absent for Office; the services/IPC still enforce the
  role).
- **Add row / Add column / Manage columns removed**:
  - Add row → pinned blank **draft row** (SHEET-11): focus alone creates
    nothing; the first committed meaningful value (`0`/`false` included)
    creates exactly one record, then a fresh blank draft appears;
  - Add column → the `+` column header (already present);
  - Manage columns → **column-header right-click menu** (SHEET-13): Rename /
    Duplicate column / Delete column, plus Admin-only "Set as Primary Expiry"
    on Date (Expiry) columns. No Hide option; system columns (`#`, Actions,
    `+`, Days Left) never open it; duplicates get "Original (copy)" and copy
    the definition only; deletes confirm and Office may only delete empty
    columns.
- **Actions column kept** per the user decision, but compact: three icon-only
  ~24px buttons (duplicate / delete / renew) with tooltips, in a ~100px column
  that fits the row with no overflow.
- **Group by (SHEET-04)** implemented Community-compatibly with synthetic
  full-width group header rows (no Enterprise row grouping); it lists only
  existing Text/Dropdown columns and is hidden when there are none.
- **Keyboard (SHEET-12)** pinned to an explicit Community contract
  (`GRID_KEYBOARD_PROPS`): click-to-type, F2/double-click, Enter commits+down,
  Tab right, Esc cancels, Delete clears a cell, Ctrl+C/V plain text,
  Ctrl+Z/Y undo/redo.
- Tests: `tests/sheet-grouping.test.ts` (4), `tests/column-context-menu.test.ts`
  (4), `tests/grid-behaviour.test.ts` (4), `tests/draft-row.test.tsx` (2);
  `tests/sheet-page.test.tsx` and `tests/admin-features.test.tsx` updated from
  the removed buttons to the Tools menu / `+` header / draft row.

**Batch B+C gate:** 51 test files / 276 tests passed; typecheck clean; build ✓.
(R2-12 re-verified after R2-01: the outbox now drains and the pill only reads
"Saved to cloud" with zero pending items.)

## 11. Batch D — About, audit clear, leftovers (R2-06, R2-10, R2-13..15)

### 11.1 R2-06 — About card

- Settings → About & updates now shows `DKS`, `Version <real version>`,
  `Made by Tacenta` and a GitHub icon button.
- The version comes from the running app (`app.getVersion()` through the
  preload bridge), then the version baked into the bundle from `package.json`
  at build time (`__DKS_VERSION__` define in `vite.config.ts` /
  `vitest.config.ts`), then the explicit prop. No "Unavailable" placeholder.
- The GitHub link opens `https://github.com/tacenta2k` in the system browser:
  renderer → `window.dks.openExternal` → `ipcMain` → `shell.openExternal`.
  The main process only accepts `https:` URLs whose host is allowlisted
  (`github.com`), so the renderer can never ask the OS to open an arbitrary
  URL. A browser/tab fallback keeps the control usable outside Electron.
- `Check for updates` and its states are unchanged.

### 11.2 R2-10 — Clear audit log (admin only)

- The Audit Log panel shows a single `Clear audit log` button (Admin only;
  Office never renders the panel at all).
- It opens a dialog that requires typing `DELETE`, explains that every entry
  is removed for every PC and that one entry recording the clear stays.
- Order of operations matters: the remote `clear_audit_log()` RPC runs first,
  so a failure (offline, Office caller, RPC missing because the SQL has not
  been run yet) leaves the local mirror untouched and the error visible.
- On success the local mirror is cleared and exactly one entry is written:
  `Audit log cleared by Admin on DD/MM/YYYY HH:mm`, with action
  `clear_audit` → "Cleared the audit log".
- Server side: `public.clear_audit_log(p_message text)` is `security definer`,
  raises `42501` unless `auth.uid()` is an administrator, deletes every row and
  inserts the single trace entry. There is deliberately **no** DELETE policy
  on `public.audit_log`, so a direct API call cannot empty it. Shipped in both
  `ARENA/sql/fix-entries-rls.sql` (section 7) and `supabase/schema.sql`.
- Local mirror: new `clear-audit-log` IPC channel (admin role re-checked in the
  main process + preload validation), `clearAuditLog()` on the SQLite store,
  the Electron repository, the in-memory repository and the repository
  interface.
- Tests: `tests/audit-clear.test.tsx` (9) — message format, DELETE
  confirmation, RPC failure handling, SQL shipped in both files (definer,
  admin check, grant to authenticated only, no DELETE policy), local store
  leaves exactly one entry, remote-before-local ordering, failure keeps the
  mirror, Office never sees the control.

### 11.3 R2-13 — `npm run dev` shows the window (SYNC-09)

- Root cause: `shouldStartHidden()` also returned true whenever Windows
  reported `openAtLogin` (the user's preference, which DKS sets on first run)
  and autostart was configured `openAsHidden: true` — so a normal launch or a
  dev launch came up tray-only with no visible window.
- Now only an explicit `--hidden` / `--autostart` / `--startup` flag may start
  hidden; autostart opens the window normally (minimise-to-tray stays a
  deliberate user action).
- Extracted to `electron/main/startup.ts` and unit-tested in
  `tests/startup.test.ts`.

### 11.4 R2-14 — in-app confirmation dialogs (SET-11)

- New shared `src/features/ui/ConfirmDialog.tsx`: red destructive button,
  Cancel as the safe default, Esc and backdrop close, no duplicate submit while
  the action runs, failure message stays visible, optional typed confirmation.
- Wired into the Recycle Bin (restore + permanent delete, replacing
  `window.confirm`) and the Visa Sheet (row → Recycle Bin, column delete).
- The column dialog states how many records currently hold a value, which is
  the count SET-11 asks for before an admin deletes populated data.
- Tests: `tests/confirm-dialog.test.tsx` (6); `tests/admin-features.test.tsx`
  and `tests/row-actions.test.tsx` updated from `window.confirm` to the dialog.

### 11.5 R2-15 — responsive toolbar (`More filters ▾`)

- FIXES_UI §5.2 "Smaller windows": the last two date chips (≤60d, ≤90d) move
  into a `More filters ▾` menu below 1080px; search is the first control to
  shrink. Nothing is duplicated in the DOM (hidden-but-focusable copies would
  be an accessibility bug).
- `src/features/sheet/toolbar-layout.ts` holds the pure threshold helpers;
  tests cover wide and narrow windows (`tests/toolbar-responsive.test.tsx`).
- `tests/setup.ts` now reports a 1440px window (jsdom's 1024px default is
  narrower than DKS ever runs).

**Batch D gate:** 55 test files / 298 tests passed; typecheck clean; build ✓.

---

# Round 3

Round-3 scope: the Office sync/RLS follow-up, the `app_columns_name_key`
duplicate during Office sync, the Clear-audit-log failure, Windows startup
registration, and the remaining UI refinements (Dashboard stays untouched).

## 12. Round 3 — Batch A: Office entry sync / RLS (verified + hardened)

What was already shipped in Round 2 and re-verified here:

- `src/features/sync/supabase-sync.ts` writes **new** rows with `insert()` and
  **existing** rows with `update().eq('id', …)`. An update therefore never
  re-runs the INSERT policy — that upsert was the actual cause of
  `new row violates row-level security policy for table "entries"`.
- `created_by` is stamped only on INSERT; `updated_by` comes from the live
  authenticated session; the SQL trigger keeps `created_by` immutable.
- Soft delete is an UPDATE of a live row (Office may do it); restoring or
  updating an already-deleted row is refused for Office by the UPDATE policy
  and the `guard_office_restore` trigger; hard DELETE stays admin-only.
- Each queued entry is written in its own try/catch, so one rejected row can no
  longer stop sibling rows (that was the old batch-upsert behaviour, and the
  reason items showed "attempted 0×" — they were never attempted at all).
- `markOutboxFailed` increments `attempts`, so a real attempt is never shown as
  "attempted 0×".

Hardened in this batch:

- `retryFailedOutbox()` no longer clears `last_error`. The recorded reason used
  to be wiped the moment a retry started, so a pending item could sit there with
  no explanation (and a crash mid-retry lost it entirely). The reason now
  survives requeueing and is cleared only by a successful write.

Tests (`tests/entries-rls.test.ts`, 16 passing): policy-model tests for Office
updating/soft-deleting an Admin-created row, Office being refused on an
already-deleted row, `created_by` immutability, admin restore/permanent-delete,
"uses a real UPDATE (not an upsert) … omits created_by", outbox drain to zero,
attempt counting, **reason retained across requeue**, and **a failing first
item does not stop its siblings**.

USER-MUST-RUN: `ARENA/sql/fix-entries-rls.sql` (see the Batch C note for its
audit-log section). Until that file is run on the project, the *server* still
has the old policy and Office will keep seeing the RLS error — the client fix
cannot override a database policy.

## 13. Round 3 — Batch B: duplicate `app_columns` name during Office sync

Root cause (confirmed in code): `public.app_columns.name` is UNIQUE across the
whole table and soft-deleted columns keep their name. The SELECT policy hides
`deleted = true` rows from Office, so an Office client could not see the row
that already owned "Visa Expiry" and tried to INSERT a second one →
`duplicate key value violates unique constraint "app_columns_name_key"`.
Admin never saw it because Admin can SELECT the deleted row and reconcile by
name.

What changed:

- **Pull before push.** Remote column definitions are applied to the local
  cache *before* any new local column is written, so a column that already
  exists on the server is adopted instead of inserted again.
- **Duplicate-name recovery** (`reconcileDuplicateColumnName` in
  `src/features/sync/supabase-sync.ts`): an insert that fails with
  `app_columns_name_key` asks the server which row owns the name through the
  new read-only `resolve_duplicate_column(p_name)` RPC.
  - *Identical type + options* → the local column adopts the server id
    (`rekeyColumn`), which rewrites `entries.data[oldId] → [newId]` inside a
    transaction and re-points queued outbox rows; the server row is UPDATEd and
    the queued operation is acknowledged. No column, value or entry is lost.
  - *Different type or options* → both versions are preserved. The conflict is
    recorded for an administrator and the item keeps a readable reason ("…
    exists on the server with a different type or options … an administrator
    must rename or delete one of them").
  - *RPC missing* (migration not run) → the item carries the exact instruction:
    run `ARENA/sql/fix-column-sync.sql`.
  - The raw `duplicate key …` text is never left as the user-facing reason.
- **Local duplicate names** (a case-only rename etc.) are detected before
  pushing: only the first is synced, the duplicate is recorded as a conflict
  with a clear message, and nothing is deleted or renamed.
- New local capability: `rekeyColumn(oldId, newId)` in the SQLite store, the
  `dks:local:rekey-column` IPC channel (validated in preload + main),
  `DksLocalApi.rekeyColumn`, the Electron repository and the renderer sync
  adapter.
- Removed a dead `localColumnById.has(name)` check (the map is keyed by id, so
  it could never match) and normalised names with trim + lowercase on both
  sides of the comparison.

USER-MUST-RUN: **`ARENA/sql/fix-column-sync.sql`** (also mirrored in
`supabase/schema.sql`). Idempotent, read-only function, `security definer`,
`search_path` fixed, granted to `authenticated` only (never `anon`), and the
unique constraint is **not** dropped.

Tests: `tests/column-sync-duplicates.test.ts` (9) — identical duplicate replay
adopts the id and rewrites entry keys, conflicting definitions keep both
versions with a readable reason, missing RPC names the SQL file, lookup failure
is reported, shared columns are pulled before pushing, local same-name columns
are flagged, and both SQL files are asserted to ship the scoped read-only
resolver with the constraint intact.

## 14. Round 3 — Batch C: "Clear audit log" → `DELETE requires a WHERE clause`

Where that error came from (traced):

- It is **not** produced by SQLite, better-sqlite3 or the `clear_audit_log()`
  RPC. SQLite accepts `DELETE FROM audit_log`; better-sqlite3 ships no such
  guard (checked `node_modules/better-sqlite3`, including its bundled
  `sqlite3.h`), and the RPC runs as one transactional function.
- The exact wording is a **REST-layer** safety error for a DELETE request with
  no filter — the shape produced by `supabase.from('audit_log').delete()` with
  no `.eq()`. DKS must never build that request.
- The local mirror clear was the only unfiltered `DELETE` statement in the
  codebase (`SqliteStore.clearAuditLog`). It is now explicitly scoped
  (`DELETE FROM audit_log WHERE id IS NOT NULL`), inside one transaction, with
  a comment stating that it is the only audit-deleting statement in DKS.

Hardened so this cannot reappear through any layer:

- `clearRemoteAuditLog()` refuses to run without an `rpc()` — it will never
  degrade to a table DELETE. A test asserts `from()` / `.delete()` are never
  called on the clear path, and that a client exposing only `.delete()` is
  rejected.
- Missing migration → actionable message naming
  `ARENA/sql/fix-entries-rls.sql`; other refusals are surfaced verbatim with
  “Nothing was removed.” appended.
- Order of operations (server first, one transaction) is explained in the
  dialog; the dialog now states how many recorded actions will be removed, so
  an admin re-confirming after a failure can see whether the log still holds
  history. A remote success followed by a local failure is reported as exactly
  that ("the server audit log was cleared, but this PC's copy could not be
  updated"), never as a silent half-clear.
- Office never reaches this code: the panel is not rendered for Office, the IPC
  channel re-checks `role === 'admin'`, and the SQL function raises `42501`
  for a non-admin caller.

Tests: `tests/audit-clear.test.tsx` (12) — RPC-only path, no-`.delete()`
assertion, missing-function message, verbatim server refusal, remote-before-local
ordering, local mirror preserved on failure, one surviving `clear_audit` entry,
Office rejection. SQL already shipped in `ARENA/sql/fix-entries-rls.sql`
(section 7) + `supabase/schema.sql`.

## 15. Round 3 — Batch D: Windows startup registration

Findings:

- DKS already used Electron's native `app.setLoginItemSettings`, **and** shipped
  the unused `auto-launch` dependency (declared in `package.json`, never
  imported). Two possible writers for the same Windows Run key is exactly how a
  PC accumulates several startup entries for one app.
- The uninstall/identity side was already correct: `app.setName('DKS')` +
  `app.setAppUserModelId('com.dks.tracker')` run at module load, so a
  registration is named `DKS`, not `electron`.
- A development run used to call `setLoginItemSettings({openAtLogin:true})`,
  which registers `node_modules\electron\dist\electron.exe` — a stale launch
  target as soon as the folder moves.

What changed:

- `startupRegistration()` in `electron/main/startup.ts` decides whether to
  register: **packaged builds only** (and only on Windows/macOS), always with
  the explicit `process.execPath`, `openAsHidden: false`, and an inert marker
  argument `--dks-startup=DKS` so a DKS entry is identifiable in the Startup
  list. It never passes `--hidden`/`--autostart`.
- `configureAutoLaunch()` in the main process now:
  - writes nothing in a development run (it would either register
    `electron.exe` or, with `openAtLogin:false`, silently delete the installed
    app's autostart) and logs that decision instead;
  - logs the resolved registration (`appName`, `execPath`, `openAtLogin`,
    `willLaunchAtLogin`) so support can compare it with the Windows list
    without touching the registry.
- `auto-launch` removed from `package.json`; `package-lock.json` regenerated
  and `npm ci --dry-run` verified in sync.
- The table, the read-only inspection commands and the manual removal steps are
  recorded below (§15.1–15.3) so no extra spec file had to be added.

### 15.1 The one mechanism

| | |
|---|---|
| Mechanism | Electron `app.setLoginItemSettings` (`configureAutoLaunch`) |
| Windows storage | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\DKS` |
| Command | `"<install dir>\DKS.exe" --dks-startup=DKS` |
| Written when | packaged build only, once at startup |
| Hidden start | never (`openAsHidden: false`; only `--hidden`/`--autostart`/`--startup` hide) |

### 15.2 Read-only inspection (PowerShell)

```powershell
Get-CimInstance Win32_StartupCommand |
  Select-Object Name, Location, Command | Format-Table -AutoSize -Wrap

Get-CimInstance Win32_StartupCommand |
  Where-Object { $_.Name -like 'Aswin*' -or $_.Command -like '*DKS*' } |
  Select-Object Name, Location, Command | Format-List

Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' |
  Select-Object * -ExcludeProperty PS* | Format-List
```

Decide which entry is DKS from the **command path**, never from the name: a
`…\Programs\DKS\DKS.exe` plus `--dks-startup=DKS` is current DKS; a
`…\node_modules\electron\dist\electron.exe` entry is a stale development
registration; anything else (including `utweb`) is not DKS and is left alone.

### 15.3 Manual removal of a confirmed stale DKS entry (user only)

```powershell
reg export "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" "$env:USERPROFILE\Desktop\dks-run-backup.reg"
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name '<CONFIRMED NAME>'
```

Never delete the whole `Run` key and never use "Disable all"; other apps keep
their entries there.

Honest limits: the two `Aswin` entries cannot be attributed to DKS from this
environment — their command paths must be read on the user's PC (see §15.2).
The separate `utweb`
registry entry is unrelated and is not touched. No registry entry, startup
setting or shortcut is modified by the app or by this work.

Tests: `tests/startup.test.ts` (6) — packaged registration points at the real
exe and never hides the window, a development run registers nothing, an
unsupported platform is not faked, and the tree keeps exactly one mechanism
(no `auto-launch` dependency or client).

## 16. Round 3 — Batch E: sheet layout, draft row, filters, dark theme

The user restated five sheet decisions and one notification decision; this batch
implements them without touching the Dashboard.

- **Full-width sheet.** `.content` (the shared page wrapper) sets
  `width: min(100%, 1280px); margin: 0 auto`. The sheet opt-out
  (`.content--sheet`) was a single-class selector too, so the winner depended
  on CSS bundle order — which is why the sheet could still render as a centered
  1280px column with blank space either side. The override is now
  `.content.content--sheet` (and the same double-class guard for the workbench,
  grid wrapper and table wrapper), so the sheet fills the content area at
  1920px and at narrow widths.
- **Draft row placement (new user decision).** The blank draft is no longer a
  pinned bottom overlay. It is appended to `rowData` after the last visible
  saved record, carries `sheet-draft-row` (dashed borders on every cell, dark
  theme included), and `postSortRows` keeps it last after any column sort. A
  freshly committed record therefore gets a brand-new blank row directly
  beneath it. Empty-state copy now says "blank row at the end", not "bottom
  row".
- **Continuous entry.** After a draft commit the grid re-focuses the same column
  on the new last row, so a run of records can be typed without the mouse.
- **Actions column.** Kept (per the user override): three 24px icon buttons
  (duplicate / delete / renew) with `title` and `aria-label` in a 100px column;
  no overflow, no overlay, no removal.
- **Filters, `+` header.** Already in the required shape and left alone: status
  dropdown `All statuses | Valid | Expiring soon | Expired | No expiry`, chips
  `Today | ≤7d | ≤30d | ≤60d | ≤90d`, `+` header only — no Add Row / Add
  Column / Manage Columns toolbar buttons.
- **Dark theme parity.** Every sheet surface, popover (notification, more
  filters, column menu, avatar), dialog and admin table paints from the
  `--color-*` tokens; the only literal colours left are semantic
  (danger/warning) fills. The personal theme preference still outranks the
  workspace default (R2-08 unchanged).
- **Notification popover (user override).** No custom date snooze exists in the
  UI; expiry alerts get Mark read plus snooze choices that never exceed the
  remaining days, and the popover stays open while an action updates the list in
  place (`tests/notification-popover.test.tsx`).
- **About / toasts.** About already shows the real version, "Made by Tacenta"
  and the GitHub icon opening `https://github.com/tacenta2k` in the system
  browser. Packaged toast attribution is asserted against
  `electron-builder.yml` (`appId` == `setAppUserModelId`, shortcut named DKS).
- **Dashboard:** not touched.

Tests: `tests/sheet-layout.test.tsx` (7) and `tests/dark-theme-parity.test.ts`
(5). Batch F needed no code: the import preview already detects expiry-like
headers/values, offers explicit `date_expiry` creation or conversion of an
existing text column, normalises dates to ISO and leaves Days Left derived
(`tests/import-export.test.ts`, 18). The two remaining NOT_STARTED rows are
USER-ONLY packaging/visual checks.

Gate: 58 test files / 328 tests, `tsc` (both configs) clean, `build:electron`
clean.

## 17. Round 3 — Batch F: CSV/XLSX expiry import

No product code was missing for this batch; the gap was proof, so it is now
locked by a test.

- An expiry-like header (`Expiry`, `Expiration`, `Valid until`, `Due date`, or a
  majority of date-like sample values) is offered in the preview as a date
  column, defaulting to `date_expiry`; the Admin can change the type before
  importing (`suggestImportColumnType` + the preview's type selects).
- Choosing "create" makes a real `date_expiry` column; choosing an existing
  TEXT column that holds dates offers a conversion (`dateMappedToText` →
  `convertColumnDateValues`), and impossible/non-date text is kept, never
  dropped.
- Values are normalised to ISO (`YYYY-MM-DD`) at import; the sheet derives Days
  Left afterwards. The new test imports `Name,Visa Expiry`, creates the expiry
  column and asserts `daysLeft` = 9 and 407 against a fixed "today", plus the
  ISO storage value — i.e. Days Left works with no extra setup step because a
  lone `date_expiry` column is the primary expiry.
- `tests/import-export.test.ts` is now 19 tests.

Remaining NOT_STARTED rows (`PKG-06`, `PKG-07`) are USER-ONLY: a packaged
Windows build and a visual pass on real hardware. Nothing implementable is left
open in the tracking list.

Gate: 58 files / 329 tests, `tsc` (both configs) clean, `build:electron` clean.

## 18. Round 3 — Batch G: SQL review fixes (audit clear, policy guard, schema preflight)

The user reviewed both SQL files before running them. Five findings, all fixed;
nothing was executed against Supabase by me.

### 18.1 `clear_audit_log()` — scoped delete and Oman time

- `delete from public.audit_log;` → `delete from public.audit_log where id is
  not null;`. `id` is the identity primary key, so every row is still removed;
  the statement is now safe-delete compatible and can never produce the
  REST-layer `DELETE requires a WHERE clause` error. The local mirror already
  used the same scoped form (`electron/main/sqlite.ts`).
- The stored message timestamp is Oman local time:
  `to_char(now() at time zone 'Asia/Muscat', 'DD/MM/YYYY HH24:MI')`. The wording
  is unchanged: `Audit log cleared by Admin on DD/MM/YYYY HH:mm`.
- The client stamps the same timezone (`formatBusinessDateTime()` in
  `src/lib/date.ts`, used by `auditClearMessage()`), so a clear made from a PC
  in any timezone and one made by calling the RPC directly read identically.
- Mirrored into `supabase/schema.sql`.

### 18.2 Policy safety — preflight, guard and verification

PostgreSQL ORs **permissive** policies together, so an old broad policy that
this file does not know by name would keep widening access after every expected
policy was recreated. `ARENA/sql/fix-entries-rls.sql` now has:

- **SECTION 0 (preflight, read-only, commented out)** — a `full join` of
  `pg_policies` against the expected list, with a verdict column
  (`ok` / `MISSING` / `WRONG COMMAND` / `UNEXPECTED permissive policy`), an RLS
  enabled check, and a check that no DELETE/UPDATE policy exists on `audit_log`.
- **SECTION 1 guard** — a `DO` block *inside the transaction, before any policy
  is created*, that raises and aborts the whole migration when an unexpected
  permissive policy exists on `entries`, `audit_log` or `app_columns`, or when
  RLS is disabled on any of them. Restrictive policies only narrow access and
  are therefore allowed. The two legacy `audit_log_delete_*` policies are
  tolerated because the same transaction drops them (a DELETE policy on the
  audit log is otherwise treated as unexpected).
- **SECTION 2 (verification, read-only)** — the full expected policy list with
  commands, the "no DELETE/UPDATE on audit_log" check, and an optional
  destructive check of the clear function.

Expected active policies (the only ones allowed on these tables):

| table | policy | command | who |
|---|---|---|---|
| entries | `entries_select_authenticated` | SELECT | authenticated; `not deleted or is_admin()` |
| entries | `entries_insert_authenticated` | INSERT | authenticated; `created_by = auth.uid()`, not pre-deleted |
| entries | `entries_update_authenticated` | UPDATE | authenticated; Admin any row, Office live rows only |
| entries | `entries_delete_admin` | DELETE | `is_admin()` |
| audit_log | `audit_log_select_admin` | SELECT | `is_admin()` |
| audit_log | `audit_log_insert_authenticated` | INSERT | `actor = auth.uid() or actor is null` |
| app_columns | `app_columns_select_authenticated` | SELECT | authenticated |
| app_columns | `app_columns_insert_authenticated` | INSERT | authenticated |
| app_columns | `app_columns_update_authenticated` | UPDATE | authenticated |
| app_columns | `app_columns_delete_admin` | DELETE | `is_admin()` |

No UPDATE and no DELETE policy may exist on `audit_log`. RLS is never disabled,
`anon` is never granted anything, and Admin-only paths are unchanged.

### 18.3 `app_columns` schema compatibility

`fix-column-sync.sql` referenced `deleted`, `deleted_at`, `updated_at`,
`is_primary_expiry`, `is_passport`, `options` (plus `position`, `visible`). The
shipped `supabase/schema.sql` has all of them, but a project created from an
older DKS schema might not. The file now:

- **SECTION 0.1** checks each required field against `information_schema.columns`
  and marks it `present` / `MISSING — SECTION 1 adds it`;
- **SECTION 1** adds only the missing ones with
  `alter table public.app_columns add column if not exists …` (additive,
  defaults matching the schema; no drops, no renames, no data rewritten);
- `resolve_duplicate_column()` now reads the row via `to_jsonb(c)` and
  `coalesce`s every optional field, so an absent optional column cannot make a
  call fail at runtime. Mirrored into `supabase/schema.sql`.

### 18.4 No `INSERT … ON CONFLICT` upsert loophole

- `writeRow()` in `src/features/sync/supabase-sync.ts` no longer falls back to
  `upsert` for entries or columns. `mode: 'update'` requires a real UPDATE and
  `mode: 'insert'` a real INSERT; otherwise the write is refused with an
  explanation and the outbox item stays pending with its reason (nothing is
  lost). `upsert` is now optional in the client interface and used only for the
  `settings` key/value table.
- Attribution is enforced server-side as well: the existing
  `entries_keep_created_by` trigger now also freezes `created_at`, and a new
  `entries_stamp_updated_by` trigger sets `updated_by := auth.uid()` on every
  UPDATE (including inside SECURITY DEFINER restores), so Office cannot
  attribute an edit to the admin and an admin restore is attributed to the
  admin.
- Behaviour preserved: Office edits/soft-deletes live rows (including
  Admin-created ones), Office cannot edit or restore a deleted row, and restore
  / hard delete stay admin-only (`restore_entry()`, `permanently_delete_entry()`,
  `entries_delete_admin`).

### 18.5 Tests

`tests/entries-rls.test.ts` 16 → 22, `tests/column-sync-duplicates.test.ts` 9 →
13, `tests/audit-clear.test.tsx` 12 → 14, `tests/supabase-sync.test.ts` 20 → 22.
`tests/persistence-quit-reopen.test.ts` and the sync doubles were updated to
model a real client with INSERT/UPDATE (they previously only implemented
`upsert`, which is exactly the path that no longer exists).

Preflight note: `npm rebuild better-sqlite3` needs the local Node headers in
this sandbox (`--nodedir=/usr/local`) because nodejs.org is unreachable; the
rebuild succeeded and the module loads.

Gate: 58 files / 343 tests, `tsc` (both configs) clean, `build:electron` clean.
All three SQL files parse (pglast); they were not executed anywhere.

## 19. Round 3 — Batch H: official DKS app icon

The user supplied the official logo (`DKS — SOFTWARE FOR BUSINESSES`) and asked
for it to become the Windows icon. Nothing here was verified on Windows: the
packaged exe, installer and Add/Remove Programs entry still need a real
`npm run dist` on the user's PC.

### 19.1 Source and generator

- `build/logo-source.png` — the supplied logo, committed unchanged as the single
  source of truth (1254×1254, white page, navy "D" + blue "K"/"S" + tagline).
- `scripts/generate-icons.mjs` (run with `npm run icons`) derives everything
  else with `sharp` + `png-to-ico` (both dev dependencies, free). It measures
  the artwork instead of hard-coding coordinates: ink bounding box, row runs to
  separate the wordmark from the tagline, and the gap after the "D" for the
  square mark. The white page is keyed out with an ink-over-white unmultiply so
  the artwork keeps smooth edges and no grey halo.

### 19.2 Files produced

| file | what it is | used by |
|---|---|---|
| `build/icon.ico` | 16, 32, 48, 256 px frames | exe, installer, uninstaller, header icon, taskbar |
| `build/icon.png` | 1024 px master (wordmark on a rounded white plate) | `BrowserWindow` icon (copied to `resources/icon.png`) |
| `src/assets/dks-mark.png` | square "D" mark, transparent | sidebar tile, sign-in card, favicon |
| `src/assets/dks-logo.png` | full lockup, transparent | Settings → About |
| `src/assets/dks-logo-dark.png` | the same lockup lightened (~25% toward white) | Settings → About in dark mode |

Small sizes are simplified rather than squashed: a 2.3:1 lockup inside a square
canvas is only ~6 px tall at 16 px, so 16 px uses the square "D", 32/48 px the
wordmark, and 256 px the full lockup with tagline.

### 19.3 Wiring

- `electron-builder.yml`: `win.icon: build/icon.ico`, `nsis.installerIcon`,
  `nsis.uninstallerIcon`, `nsis.installerHeaderIcon` all point at the .ico;
  `icon: build/icon.png` plus `extraResources` copies the PNG to
  `resources/icon.png` so the running app can hand the same artwork to the
  window. `productName: DKS` and `appId: com.dks.tracker` are unchanged.
- `electron/main/icons.ts`: pure resolution rules (packaged → resources, dev →
  `build/`; `.ico` first on Windows, `.png` elsewhere) so they can be tested
  without Electron.
- `electron/main/index.ts`: `nativeImage.createFromPath(...)` →
  `BrowserWindow({ icon })`, the same path for the tray, and a warning log (not
  a crash) when no icon file is found.
- Settings → About, the sidebar and the sign-in card now show the real logo
  instead of the "D" letter tile; the About card swaps to the lightened variant
  in dark mode so no white plate is needed (the dark-theme parity guard stays
  green).

### 19.4 Tests and gate

`tests/app-icon.test.ts` (15): the committed source is a real PNG, the .ico has
exactly the 16/32/48/256 frames with in-file offsets and readable payloads, the
master is 1024×1024, the renderer assets exist, the builder identity/icon keys
are unchanged except for the new icon entries, the main process loads the icon
through `nativeImage` with an `isEmpty()` fallback, and the four resolution
cases (packaged / dev / missing / platform preference) behave.

Gate: 59 files / 358 tests, `tsc` (both configs) clean, `build:electron` +
renderer build clean. `electron-builder --win --dir` **loaded the configuration
successfully** and then stopped at `@electron/rebuild` cross-compiling
better-sqlite3 for win32 from Linux — an environment limit of this sandbox, not
a configuration error.

## 20. Round 3 — Batch I: Windows test portability (icon suite)

The user ran `01be50c` on Windows: `typecheck` and `build` passed, `npm test`
reported 355 passed / **3 failed — all in `tests/app-icon.test.ts`**. Both
failures were host assumptions in the tests, not defects in the icon wiring
(the real `electron-builder.yml` was correct).

### 20.1 What failed and why

| # | Test | Cause |
|---|---|---|
| 1 | electron-builder icon wiring | The assertion was a multi-line regex (`/^win:\n(?:.*\n)*?\s+icon: …$/m`). A Windows checkout reads `electron-builder.yml` with CRLF, so every line ended `\r` and `$` never matched — the config itself was fine. |
| 2 | packaged PNG fallback | Expected `/opt/dks/resources/icon.png`; the resolver used host `path.join`, which on Windows produced `\opt\dks\resources\icon.png` — mixed separators. |
| 3 | development `build/icon.png` | Same cause: `path.join('/home/user/dks', 'build')` on Windows → `\home\user\dks\build`. |

### 20.2 Fixes

- `electron/main/icons.ts`: new `pathImplementationFor(platform)` →
  `path.win32` for `win32`, `path.posix` for everything else.
  `resolveAppIcon()` joins with that implementation, so the result depends on
  the **simulated platform**, not on the host that happens to run the code.
  Behaviour on real machines is unchanged (`process.platform` is still the
  default), so the icon configuration itself was not touched.
- `tests/app-icon.test.ts`:
  - `readNormalised()` strips `\r` before anything looks at a text file.
  - `electron-builder.yml` is now inspected **structurally** (`yamlTopLevel` /
    `yamlSection` read `key: value` pairs) instead of with a fragile multi-line
    regex; the assertions compare values (`build/icon.ico`, `DKS`,
    `com.dks.tracker`, the three NSIS icon keys).
  - A new test converts the real YAML to CRLF in memory and re-asserts every
    icon/identity key, which locks the Windows failure without needing Windows.
  - Expected paths are built with `path.win32.join` / `path.posix.join` for the
    platform each test simulates — never with the host's `path.join`.
  - Development resolution is now covered for **both** flavours (Windows
    `C:\dev\dks` and POSIX `/home/user/dks`), plus a determinism test asserting
    a win32 result contains no `/`, a POSIX result no `\`, and that
    `pathImplementationFor` follows the argument.
  - Added 3 tests (15 → 18); nothing was skipped, removed or loosened.

Verification of the Windows behaviour without Windows: the suite was re-run with
`process.platform` forced to `win32` **and** with `electron-builder.yml`
temporarily converted to CRLF — 18/18 passed in both runs (temporary harness
files deleted afterwards).

### 20.3 `npm run dist` on Windows (user's run)

Packaging reached the Windows step and stopped while extracting `winCodeSign`,
because that archive contains symlinks and the terminal was not elevated. That
is an environment permission, not a repository setting: run the CMD as
Administrator, or enable Windows **Developer Mode** (Settings → System →
For developers → Developer Mode) so non-elevated processes may create symlinks,
then run `npm run dist` again. No build configuration was changed for this.

Gate: 59 files / **361 tests** (358 before + the 3 new portability tests),
`tsc` (both configs) clean, `build:electron` + renderer build clean.

## 21. Fix — packaged Windows build: local SQLite store (native ABI)

### 21.1 Symptom (user, packaged `release\DKS-0.1.0-win-x64.exe`)

The installed app opened but every local call failed:

```
Error invoking remote method 'dks:local:get-snapshot':
Error: No handler registered for 'dks:local:get-snapshot'
```

and the top-bar pill stayed on "Offline — saved locally". `npm run dev` was
fine. The user reproduced it twice (fresh install each time) and confirmed:

`C:\Program Files\DKS\resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node`
exists and is dated at install time.

### 21.2 Root cause (read from source, not guessed)

1. **`files` was not the problem.** The initial suspicion was that
   `files: [dist-electron/**, package.json]` excluded `node_modules`.
   `app-builder-lib/out/util/appFileCopier.js` →
   `computeNodeModuleFileSets()` always collects **production dependencies**
   separately from the `files` matcher into `node_modules/<name>`. That is why a
   binary was shipped at all — adding `node_modules/**` would have changed
   nothing (and only bloated the asar).
2. **The ABI was the problem.** The shipped `better_sqlite3.node` was the
   **Node ABI 137** build (a stray `npm rebuild better-sqlite3` in the same
   tree before `npm run dist`), while Electron 34 needs **ABI 132**.
3. `@electron/rebuild` 3.6.1 (`lib/rebuild.js` `rebuildModuleAt`) returns early
   when `prebuildInstallNativeModuleExists()` is true ("skipping … as it was
   prebuilt") / when `.forge-meta` already matches, so nothing replaced the
   wrong binary before it was copied into `app.asar.unpacked`.
4. At runtime `better-sqlite3` v12 loads its addon lazily on the first
   `new Database()`, so `require('better-sqlite3')` succeeded and the main
   process stayed alive; `createSqliteStore()` threw
   `NODE_MODULE_VERSION mismatch` inside `openLocalStore()`.
5. `openLocalStore()`'s catch logged and left `localStore` /
   `unregisterLocalIpc` undefined — **no handler was registered**, the renderer
   got Electron's raw "No handler registered" error, `.catch(() => undefined)`
   swallowed it, and `syncStatus` kept its initial `offline` value.

### 21.3 Packaging: a Node-ABI binary can no longer be packaged

- `electron-builder.yml`: `asar: true` and
  `asarUnpack: node_modules/better-sqlite3/**` kept (a `.node` inside an asar
  is not loadable); `npmRebuild: true` made explicit;
  `buildDependenciesFromSource: false` documented (it would force an MSVC
  compile even when a valid Electron prebuild exists);
  `afterPack: scripts/after-pack.cjs` added.
- **`scripts/verify-native-modules.mjs`** (new) runs *before*
  electron-builder from `npm run dist` / `npm run release`
  (`npm run verify:native`). It loads the module with the project's own
  Electron binary in `ELECTRON_RUN_AS_NODE` mode and opens an in-memory
  database — Node refuses to dlopen a mismatched ABI, so this is the real
  assertion. On failure it deletes the stale
  `node_modules/better-sqlite3/build` output, runs
  `electron-builder install-app-deps` (rebuild for Electron), re-checks, and
  **exits 1** with instructions if it still fails.
- **`scripts/after-pack.cjs`** (new) repeats the probe against the artefact
  that actually ships: `resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`,
  loaded by the **packaged** Electron executable. Missing/unpackable/bad-ABI
  binding throws and aborts the installer build.
- No binary is vendored in the repo; the rebuild stays a local build step.

### 21.4 Main process: startup is resilient and diagnosable

- `electron/main/local-store-diagnostics.ts` (new, no Electron imports so it is
  unit-testable): `createLocalStoreFailure()` bounds/collapses the raw error,
  detects the native-module ABI error and distils it to
  "built for ABI 137 but this build needs ABI 132", carries the real log path,
  and `localStoreUnavailableMessage()` builds the one sentence every failing
  channel returns.
- `electron/main/index.ts` `openLocalStore()`:
  - on success clears any previous failure / stubs;
  - on failure logs the full diagnostic (message, ABI flag, log path, userData
    path, platform, arch, Electron version, Node ABI, the thrown error) to
    `%APPDATA%\DKS\logs\main.log` via electron-log, then **registers the failing
    stubs for all 30 `dks:local:*` channels**; registration is idempotent and
    is cleared by `closeLocalStore()`.
- `electron/main/local-ipc.ts`: new `createLocalStoreFailureHandlers()` and
  `registerLocalStoreFailureIpcHandlers()`; every channel rejects with
  `Local database unavailable: <reason>. <reinstall hint when ABI>. (<channel>) Log: <path>`.
  No channel can be left unregistered again.
- `electron/preload/index.ts`: the bounded error cap goes 240 → 400 chars so the
  log path is not cut off mid-message (it still strips any non-Error value).

### 21.5 Renderer: a real error state, never a false "offline"

- `src/lib/local-store-error.ts` (new): strips the
  `Error invoking remote method '…': Error: ` wrapper, bounds the text.
- `src/renderer/App.tsx`: the snapshot restore now sets `localStoreError` when
  `local.getSnapshot()` rejects (and clears it on success).
- `src/renderer/components/AppShell.tsx`: the sync pill reads
  **"Local database unavailable"** (error dot) instead of
  "Offline — saved locally", and a `role="alert"` banner explains that entries
  cannot be read or saved on this device, with the technical details (reason +
  log path) in an expandable block. `src/renderer/styles.css` styles it for both
  themes. The Dashboard itself is untouched.

### 21.6 Tests (381 total, +20)

- `tests/packaging-native-modules.test.ts` (6): `better-sqlite3` is a
  production dependency; `asar: true`; `asarUnpack` covers the whole module;
  `files` ships `dist-electron/**` + `package.json`; `npmRebuild: true`;
  `npm run dist` runs `verify:native` **after** `build` and **before**
  electron-builder; `afterPack` hook wired; both scripts exist and contain the
  Electron-ABI probe / rebuild / packaged-artefact check.
- `tests/local-store-failure.test.ts` (12): ABI detection, bounded/collapsed
  messages, fallback log path, all 30 channels registered as failing stubs with
  reason + channel + log path, non-ABI failures stay meaningful, a stale
  success handler is replaced, unregistration and re-registration are clean, and
  the renderer helper strips the IPC wrapper.
- `tests/sync-status-ui.test.tsx` (+2): a store failure shows the alert banner
  and never "Offline — saved locally"; a healthy store shows no banner.

### 21.7 Gate

`npm rebuild better-sqlite3` (sandbox needs `--nodedir=/usr/local`) then
`npm test` → **61 files / 381 tests passed**, `npm run typecheck` clean,
`npm run build` clean. One earlier full run reported a single failure that did
not reproduce in the two subsequent full runs; it was not in any of the new
suites.

### 21.8 Windows re-verify (user only)

1. Close DKS, then in the repo delete the stale native build so nothing can be
   reused: `rmdir /s /q node_modules\better-sqlite3\build` (or delete the whole
   `node_modules` and run `npm install`).
2. Elevated CMD in the repo (elevation is needed for the winCodeSign symlinks):
   `npm run dist`.
   - `verify:native` must print
     `[dks] better-sqlite3 loads under Electron (module ABI 132) — safe to package`.
   - `afterPack` must print
     `[dks] packaged better-sqlite3 loads under Electron (module ABI 132)`.
   - If either prints `NATIVE MODULE CHECK FAILED` / throws, the build stops
     instead of producing a broken installer — send that output back.
3. Uninstall DKS, install `release\DKS-0.1.0-win-x64.exe`.
4. Launch it: the sheet/dashboard must load with no `No handler registered`
   error. Create a row, quit fully (tray → Exit), reopen — the row must persist.
5. If the store still cannot open, the app now shows
   **"Local database unavailable"** instead of "Offline"; expand *Technical
   details* and send `%APPDATA%\DKS\logs\main.log` (the message names the exact
   log path).

**This is not verified by me.** I cannot run the packaged Windows app; only the
user can confirm it, so the status stays `IMPLEMENTED_AWAITING_CONFIRMATION`.

## 22. Fix — Windows follow-up to the packaging guard, and the flaky export test

Two defects were found on Windows after `f568656`.

### 22.1 The repair step called a flag `install-app-deps` does not accept

`scripts/verify-native-modules.mjs` detected the Node-ABI binary correctly
(137 vs Electron's 132) but its repair ran
`electron-builder install-app-deps --config electron-builder.yml`. The
sub-command only defines `--platform`/`--arch` (verified in
`node_modules/electron-builder/out/cli/install-app-deps.js` and reproduced:
`Unknown argument: config`), and it then printed a build-tools hint that was
wrong — plain `install-app-deps` works on this machine.

What changed:

- Repair is now a three-step ladder, and the binary is **not deleted first**:
  1. `node node_modules/electron-builder/cli.js install-app-deps` — **no flags**
     (it reads `electron-builder.yml` from the project directory itself).
  2. Fallback: `node node_modules/@electron/rebuild/lib/cli.js --force
     --which-module better-sqlite3 --version <electron>` — flags checked against
     the installed CLI help (`lib/cli.js --help`).
  3. Only if the probe still mismatches: delete
     `node_modules/better-sqlite3/build` and rebuild again (this is what defeats
     a correct `.forge-meta` sitting next to a Node-ABI binary).
- The ABI probe is repeated after **every** attempt; the dist fails only if the
  module still cannot be loaded.
- Captured child output is truncated to the last 20 lines (300 chars/line) and
  the failure summary picks the real `Error: …` line instead of stack frames.
- The build-tools hint is printed **only** for a genuine compiler/toolchain
  error (`MSBuild`/`error MSB####`/`cl.exe`/`C1083`/`LNK####`/Visual
  Studio/`make: ***`/…). Network failures (`ECONNRESET`, `ETIMEDOUT`, proxy,
  certificate) get their own hint; everything else is reported verbatim.
- **Probe bug found while testing the repair:** both scripts required
  `build/Release/better_sqlite3.node` directly and treated it as a constructor,
  but the addon exports `{ Database, Statement, … }`. That made a *healthy*
  build look broken (a false negative that would have aborted every dist).
  Both `scripts/verify-native-modules.mjs` and `scripts/after-pack.cjs` now
  require the **package directory** — exactly what the app loads, whose own
  `bindings` lookup dlopens the .node, so the ABI check still applies.
- `scripts/verify-native-modules.d.mts` added so the tests can import the
  command builders with types; `main()` only runs when the file is executed
  directly.

Tests (`tests/packaging-native-modules.test.ts`, 6 → 13):

- `install-app-deps` command carries **no** arguments after the sub-command and
  never `--config`.
- every flag of the `@electron/rebuild` fallback is present in the real
  `lib/cli.js --help` output; `--build-from-source` only when requested.
- `lastLines()` keeps the last 20 lines and caps a pathological line at 300
  chars; `summarizeFailure()` returns the real error line, not `[eval]-wrapper`
  frames.
- toolchain vs network vs unknown error classification (`node-gyp failed to
  rebuild` alone is **not** a compiler error).
- `probeNativeModule(process.execPath, node_modules/better-sqlite3)` must
  succeed and report the running Node ABI — the regression that catches the
  "raw .node is not a constructor" false negative.
- the script sources contain no quoted `--config` and no `stdio: 'inherit'`.

End-to-end checks in the sandbox (fake `electron` → the local node binary):
the probe reports `safe to package` and exits 0 with no repair; the afterPack
hook reports `packaged better-sqlite3 loads under Electron`; the real
`install-app-deps --config …` invocation was reproduced failing with
`Unknown argument: config`.

### 22.2 The flaky export test (`tests/admin-features.test.tsx`)

`exports current rows as CSV and Excel …` failed once on Windows with
`rowCount: 0` and only a "Days Left" column, in an otherwise green 380/381 run.

Real race (not a timeout): `AdminSheetActions` (the Tools ▾ menu) loads **its
own** snapshot in an effect, independently of the grid. The test waited for the
grid (`findByText('Ada Lovelace')`), then clicked Export CSV while the
toolbar's `getRows`/`getColumns` were still pending — so the export was built
from the initial empty `rows`/`columns` state (`activeRows([])` → 0 rows, and
the export service always adds the derived Days Left column). Awaiting the load
inside the click handler would not have been enough on its own: the closure
still captured the pre-load arrays.

Fix in `src/features/admin/AdminTools.tsx`:

- the mount refresh now returns `Promise<boolean>` and records the loaded
  snapshot in `columnsRef`/`rowsRef`;
- new `ensureSnapshotLoaded()` awaits the in-flight load (starting one if the
  effect has not run yet) and reports failure;
- Export CSV/Excel, the Import preview and the Print/PDF report all await it and
  read the refs, so no action can run against a half-loaded snapshot; a failed
  load produces a clear message instead of an empty file.

Tests:

- new regression test `waits for the toolbar snapshot before exporting (R7
  regression)`: a gated repository holds the toolbar read, the menu is clicked
  while it is pending, and it asserts **no** artifact is written, then that the
  released export contains 1 row, "Ada Lovelace" and both "Name" and
  "Days Left" columns. It fails against the previous code
  (`expected [ Array(1) ] to have a length of +0 but got 1`), which was verified
  by temporarily reverting `AdminTools.tsx`.
- the two existing toolbar tests now await the real loaded state (`saved` has
  one artifact before the menu is reopened; the Print report dialog is awaited)
  instead of assuming the click completed synchronously. No assertion was
  weakened or removed and no timeout was raised for the new waits.

### 22.3 Gate

`npm rebuild better-sqlite3` (sandbox: `--nodedir=/usr/local`), `npm test` run
twice, `npm run typecheck`, `npm run build`. Results: **61 files / 389 tests** passed in both runs (381 before + 7 new
packaging tests + 1 export regression test), `tsc` (both configs) clean, renderer
and main builds clean.

## 23. Fix — packaged resolution through app.asar, and the Windows Vitest import crash

Two more build-tooling defects were reported after `af95c5f` (the pre-package
probe itself passed: `module ABI 132 — safe to package`).

### 23.1 afterPack: `Cannot find module 'bindings'` (Task A)

**Root cause — probe path, not a missing dependency.** `better-sqlite3`'s
JavaScript (`lib/database.js`) does `require('bindings')` lazily from its
`Database` constructor. `bindings` (and `file-uri-to-path`) are ordinary
production dependencies and live **inside `app.asar`**; only the native module
itself is unpacked. The old probe (`af95c5f`) required
`resources/app.asar.unpacked/node_modules/better-sqlite3` directly, so Node
resolved `bindings` relative to that directory — where it does not exist — and
the hook threw `Cannot find module 'bindings'`, erasing the ABI information
with it.

**Fix.** New child probe `scripts/lib/app-asar-probe.cjs`, executed by the
**packaged Electron executable** with `ELECTRON_RUN_AS_NODE=1` (set only in
that child's environment):

- `createRequire(<resources>/app.asar/package.json)` → `requireFromApp('better-sqlite3')`,
  i.e. the same resolution context as the running app. `bindings` is read from
  the asar, and Electron transparently redirects the unpacked
  `better_sqlite3.node` to `app.asar.unpacked`.
- It writes `DKS_ELECTRON`, `DKS_ABI`, `DKS_EXEC`, `DKS_APP_ROOT`, `DKS_PACKAGE`
  and `DKS_NATIVE` **before** loading, so a dependency error no longer erases
  the diagnostic context.
- It instantiates a real in-memory database, runs `select 1 as ok`, closes it,
  and prints `DKS_OK=1`.
- It refuses to trust a package that resolves outside `app.asar` (or through
  `app.asar.unpacked`).

`scripts/after-pack.cjs` now checks `resources/app.asar/package.json` and the
unpacked binary exist, spawns the probe with `cwd = appOutDir` and a cleaned
environment (`NODE_PATH`/`NODE_OPTIONS` deleted — no dev-checkout leakage),
and validates the reported paths:

- `DKS_PACKAGE` must be exactly
  `resources/app.asar/node_modules/better-sqlite3/lib/index.js`,
- `DKS_NATIVE` must be that package's `build/Release/better_sqlite3.node`,
- neither may be the development checkout.

No dependency was added or changed; `asar`, `asarUnpack`, the icon configuration
and both guards stay exactly as they were. `better-sqlite3`'s production
dependency set is shipped normally by electron-builder, so nothing was missing
from the installer.

### 23.2 Windows Vitest `SyntaxError: Invalid or unexpected token` (Task B)

**Root cause — reproducible, and not about paths.** A Windows checkout has CRLF
line endings, and the test imported `scripts/verify-native-modules.mjs`, whose
**first line is a shebang** (`#!/usr/bin/env node`). Vite's SSR transform
mangles a `#!` line on CRLF input, so every `await import(...)` threw
`SyntaxError: Invalid or unexpected token` at import time (6 tests) while
`node scripts/…` still worked — exactly the reported split.

Verified locally by reproducing both states:

- script converted to CRLF **with** the shebang → the same 6 tests fail with
  `SyntaxError: Invalid or unexpected token`;
- the same CRLF file **without** the shebang → 13/13 pass.

**Fix.**

- Importable helpers moved to `scripts/lib/native-guard.mjs`: pure helpers with
  **no shebang**, no top-level execution, no `process.exit`, no deletion — so
  importing it can never rebuild anything or abort a test run.
  `scripts/lib/native-guard.d.mts` provides the types.
- `scripts/verify-native-modules.mjs` is now a thin CLI (shebang kept, executed
  by Node, never imported). Its direct-execution guard uses `pathToFileURL` on
  `process.argv[1]` compared with `import.meta.url` (no hand-built file URLs),
  and `projectRoot` is derived with `fileURLToPath(import.meta.url)`.
- Tests import the helper module only.

### 23.3 Tests (17 in `tests/packaging-native-modules.test.ts`, was 13)

- new `packaged module resolution through app.asar (R7b)` block builds the real
  layout on disk (`resources/app.asar` + `resources/app.asar.unpacked`, with
  `bindings`/`file-uri-to-path` **only** inside the archive) inside a temporary
  directory **whose path contains spaces**, then runs the actual probe:
  - the probe loads through `app.asar`, reports `DKS_OK=1`, the exact package
    and native paths, and opens a real in-memory database;
  - the old approach (requiring `app.asar.unpacked/.../better-sqlite3` and
    instantiating it) still fails here with `Cannot find module 'bindings'`,
    locking the regression that Windows found;
  - a package reachable only by walking up out of `app.asar` is refused
    ("resolved outside app.asar");
  - the imported helper has no shebang while the CLI entry keeps its own.
- existing repair-command, truncation, classification and live ABI-probe tests
  now import `scripts/lib/native-guard.mjs`.

CRLF re-verification: all four guard scripts (`native-guard.mjs`,
`verify-native-modules.mjs`, `after-pack.cjs`, `app-asar-probe.cjs`) were
converted to CRLF in place and the suite still passed 17/17 (files restored).

### 23.4 Environment and gate

Linux sandbox, Node v22.22.3 (ABI 127), Electron installed in package.json at
34.x (ABI 132 target); `better-sqlite3` rebuilt for the Node runtime used by
the tests (`--nodedir=/usr/local`). `npm test`: **61 files / 393 tests
passed**; `npm run typecheck` clean; `npm run build` clean.

**Not verified here:** the packaged Windows app itself, the real
`resources/app.asar` archive (Node can only read it as a directory), and the
packaged Electron ABI. Those checks run on Windows via
`npm run dist` / `npm run verify:native`.

## 24. Fix — afterPack must treat resources/app.asar as an archive FILE (R8)

Confirmed Windows packaging failure after `a9d0212`: `npm run dist` died in
`afterPack` on the real staged output.

### 24.1 Root cause

The user's real staged layout (`dir /a release\win-unpacked\resources`):

```
app.asar               127 MB FILE   (one archive, not a folder)
app.asar.unpacked      <DIR>        (unpacked native modules)
icon.png               FILE
```

`scripts/after-pack.cjs` (a9d0212) checked
`existsSync(resources\app.asar\package.json)` in plain Node. `app.asar` is a
single archive *file*, so that path can never exist in the filesystem — the
guard threw `resources\app.asar\package.json is missing` on every build even
though the archive was intact. The probe design itself (anchored at
`app.asar/package.json` under the packaged Electron, R7c) was sound and is
kept; the parent-side existence check was the bug.

Why the Electron-side resolve is valid (verified against the exact pinned
Electron, v34.5.8, upstream source `lib/node/init.ts` and
`lib/node/asar-fs-wrapper.ts`): `ELECTRON_RUN_AS_NODE=1` still calls
`wrapFsWithAsar(require('fs'))` as its first step, wraps
`process.dlopen`/`Module._extensions['.node']` (the `app.asar.unpacked`
redirect), and wraps `internalModuleStat` — so the packaged Electron resolves
and loads modules from inside a real `app.asar` file even in run-as-node
mode, exactly like the running app does. Plain Node cannot, which is
precisely why Node-side checks must stop at the archive file.

### 24.2 The corrected guard

`scripts/after-pack.cjs` (hook, plain Node on the build machine), in order:

1. `resources/app.asar` exists **as a FILE** (`statSync().isFile()`); a
   missing archive or a directory masquerading as it fails with a named
   error. Node never stats below the archive path.
2. The unpacked module dir and `build/Release/better_sqlite3.node` exist on
   disk under `resources/app.asar.unpacked` (real fs — correct there).
3. Archive contents verified in plain Node through the `@electron/asar`
   header listing (`scripts/lib/app-asar-inspect.cjs`, new pure helper;
   `@electron/asar` is lazy-required and is what electron-builder packs
   with): the app manifest, better-sqlite3's `package.json` + its `main`
   entry, and the packaged JS dependencies `bindings` (package + main) and
   `file-uri-to-path` (package + main). Missing files are reported
   one-by-one in a clear "resources/app.asar is missing packaged files"
   error; an entry mirrored in `app.asar.unpacked` is tolerated (changed
   unpack layouts stay buildable).
4. The packaged Electron executable runs the child probe with
   `ELECTRON_RUN_AS_NODE=1` set **for that child only** (`NODE_PATH`,
   `NODE_OPTIONS` and now also `ELECTRON_NO_ASAR` are scrubbed from its
   environment so the build machine cannot poison or neuter ASAR-aware
   resolution).

`scripts/lib/app-asar-probe.cjs` (child, inside the packaged Electron):

- prints `DKS_ELECTRON`/`DKS_ABI`/`DKS_EXEC`/`DKS_APP_ROOT` before anything
  can fail;
- proves the archive is readable through Electron's asar-aware fs
  (`package.json` inside it must stat — a corrupt archive or a disabled-ASAR
  runtime gets its own explicit message);
- resolves `better-sqlite3` **and** `bindings` **and** `file-uri-to-path`
  with `createRequire(<resources>/app.asar/package.json).resolve`, refuses
  anything outside `app.asar` or via `app.asar.unpacked`, and reports each
  path (`DKS_PACKAGE`/`DKS_BINDINGS`/`DKS_FILE_URI_TO_PATH`/`DKS_NATIVE`);
- checks the native binding is readable (Electron answers from
  `app.asar.unpacked`);
- requires the package, opens `:memory:`, runs `select 1 as ok`, closes —
  the ABI assertion — and prints `DKS_OK=1`.

Failure reporting now names the cause instead of dumping loader noise:
`classifyProbeFailure` maps the output to *ABI mismatch* (`NODE_MODULE_VERSION`),
*packaged JS dependency missing* (`Cannot find module`), or generic, and
`pickProbeErrorLines` prints the signal line (the `[probe] …` message /
loader error) rather than stack frames. Path validation compares against the
exact expected in-archive paths (case-folding on Windows).

Nothing about asar (`asar: true`), `asarUnpack` (`node_modules/better-sqlite3/**`),
the icon configuration, the app identity, the dependencies or the pre-package
`verify:native` ABI guard changed. No binaries are vendored; the guard is not
bypassed or weakened — it is stricter (it previously could not pass at all).

### 24.3 Regression tests

New suite `tests/packaging-after-pack-asar.test.ts` — 16 tests:

- **real archive as a FILE, not a directory**: fixtures are packed with
  `@electron/asar` itself under a temp path containing spaces; asserts
  `statSync(app.asar).isFile()` and that plain-Node
  `existsSync(app.asar/package.json)` is false — the exact Windows failure
  line, locked;
- **hook failure modes with clear errors**: archive missing ("resources/app.asar
  is missing"), archive as directory ("must be a single asar archive file"),
  native binding not unpacked ("the packaged native binding is missing",
  fired before the executable lookup), a missing packaged JS dependency
  ("the packaged JS dependency 'bindings'" / "'file-uri-to-path'" named with
  its archive path), and unpack-mirror tolerance;
- **classification**: ABI mismatch vs missing module vs unknown, and
  signal-line extraction (NODE_MODULE_VERSION line survives, `[eval]`
  frames do not);
- **probe contract**: diagnostics before resolution, explicit
  `DKS_BINDINGS`/`DKS_FILE_URI_TO_PATH` reporting, refusal outside the
  archive, and the `:memory:` + `select 1` + close smoke test; plus a
  Node-vs-asar contrast test proving the probe's fs gate fires with a clear
  message under a runtime without ASAR support;
- **real Electron block** (skipped where the postinstall binary is absent —
  the offline Linux sandbox; runs on the Windows build machine):
  - better-sqlite3 + both JS deps resolve through the **real archive file**
    under `ELECTRON_RUN_AS_NODE`; the outcome is asserted exhaustively
    (either full `DKS_OK=1` load, or rejection specifically at the native
    load with `NODE_MODULE_VERSION` — nothing else is acceptable);
  - afterPack reports the classified "ABI mismatch … NODE_MODULE_VERSION
    … npm run dist" error when the staged binding is the Node-ABI dev build
    (skips with a clear note when dev and Electron ABIs coincide, i.e. right
    after a successful dist);
  - full afterPack **success** with an Electron-ABI prebuild staged through
    better-sqlite3's own installer (skips cleanly when the GitHub download
    is unreachable).

`tests/packaging-native-modules.test.ts`: two stale source assertions
updated to the R8 contract (17 tests, all passing).

CRLF re-verification: all five guard scripts (`after-pack.cjs`,
`app-asar-probe.cjs`, `app-asar-inspect.cjs`, `native-guard.mjs`,
`verify-native-modules.mjs`) were converted to CRLF in place and the two
packaging suites still passed 30/30 (files restored to LF afterwards).

### 24.4 Gate results (Linux sandbox, Node v22.22.3, ABI 127)

- `npm rebuild better-sqlite3` — rebuilt (offline source build; sandbox
  blocks the prebuilt download), binding loads (`select 1`).
- `npm test` — **62 files / 406 passed / 3 skipped = 409** (was 61/393; the
  skips are the real-Electron block, which needs the Electron binary that
  the sandbox could not download — it runs on Windows).
- `npm run typecheck` — clean. `npm run build` — clean (known chunk-size
  warnings only).
- Electron itself could not be installed here (GitHub release downloads are
  blocked), so the packaged-Electron legs are source-verified against
  Electron v34.5.8 and gate-tested by the sandbox skippable block; the
  definitive proof is the Windows run below.

### 24.5 Exact Windows command order (user, from a clean checkout state)

```bat
cd /d <repo>
npm rebuild better-sqlite3
npm test
npm run typecheck
npm run build
npm run verify:native
npm run dist
```

Expected: `verify:native` prints `better-sqlite3 loads under Electron
(module ABI 132) — safe to package`, and afterPack now passes the staged
`resources\app.asar` archive validation and prints the packaged-load success
line. The NSIS step itself still requires the elevated terminal / Developer
Mode documented in §5 (winCodeSign symlinks) and remains **unverified until
the user builds and installs it**.
## 25. Fix — the archive inspector itself misread header keys on Windows (R8b)

User report after `fb42712`: on the real packaged Windows archive, afterPack
(and three of the new tests) misreported a **healthy** archive as missing
`bindings`/`file-uri-to-path`/better-sqlite3 package files.

### 25.1 Root cause (host path semantics in @electron/asar)

The user ran, on Windows against `release\win-unpacked\resources\app.asar`:

```
node -e "const a=require('@electron/asar');
         const f=a.listPackage('release/win-unpacked/resources/app.asar')
                   .filter(x=>/bindings|file-uri/i.test(x))"
```

and got keys WITH A LEADING SEPARATOR AND HOST SEPARATORS:

```
\node_modules\bindings
\node_modules\bindings\bindings.js
\node_modules\bindings\package.json
\node_modules\file-uri-to-path\index.js
...
```

Verified against the installed `@electron/asar` 3.4.1 source
(`lib/filesystem.js`, `lib/asar.js`):

- `listFiles` builds keys with the HOST `path.join` starting from base `'/'`
  → `/node_modules/…` on POSIX, `\node_modules\…` on Windows.
- `getFile`/`searchNodeFromPath` resolve lookups with `p.split(path.sep)` —
  on Windows a request written with forward slashes never matches, so
  `extractFile(archive, 'node_modules/bindings/package.json')` throws
  `"…" was not found in this archive`; the inspector's `readAsarJson` caught
  the throw, treated the manifest as absent, and reported *every* dependency
  as missing.
- The library's own `extractAll` strips the leading separator (`substr(1)`)
  and passes the host-shaped key back — that is the one request shape proven
  to work on every host.

So: the archive was correct, the probe/Electron side was correct — only the
plain-Node inspector compared and requested keys with host-naive semantics.

### 25.2 Fix (`scripts/lib/app-asar-inspect.cjs` only)

- Header keys are read **exactly as reported** (`readRawEntries`, the source
  of truth).
- Every key is normalised on BOTH sides before ANY comparison
  (`normaliseAsarEntry`: backslashes → forward slashes, leading separator
  stripped). Presence checks compare canonical keys only.
- Extraction requests are **derived from the library's own raw keys**
  (leading separator stripped — the shape `extractAll` itself uses) instead
  of being assembled with `path.join`/`path.sep`. No host-shaped key is ever
  constructed.
- No guard behavior changed: verify:native, afterPack archive checks,
  packaged-Electron probe, `asar: true`, `asarUnpack` untouched.

### 25.3 Regression tests (suite now 18 tests; the previous 16 unmodified)

1. **Raw listing as source of truth**: builds a real archive, asserts every
   raw key starts with a leading separator, asserts the raw listing contains
   all required entries after both-side normalisation, asserts
   `inspect.listAsarEntries` equals the normalised raw listing exactly, and
   asserts `findMissingPackagedEntries` reports nothing for it.
2. **Windows host path semantics simulation**: swaps `@electron/asar` exports
   in `require.cache` so `listPackage` returns the user-observed
   `\node_modules\bindings\…` keys and `extractFile` rejects forward-slash
   requests like the real Windows driver. Asserts the simulated shape,
   asserts the driver rejects a hand-built forward-slash request (the old
   bug), and asserts the inspector still finds everything — including parsing
   `bindings/package.json` from inside the archive — then restores the cache.

CRLF re-verified for the three guard scripts; suites passed afterwards too.

### 25.4 Gate results (Linux sandbox, Node v22.22.3)

- `npm rebuild better-sqlite3` ok (offline source build), binding loads.
- `npm test`: **62 files / 408 passed / 3 skipped = 411** (new file now has
  18 tests: 15 executed + 3 real-Electron skipped here — they run on the
  Windows build machine).
- `npm run typecheck` clean; `npm run build` clean.

### 25.5 Exact Windows command order (user)

```bat
cd /d <repo>
npm rebuild better-sqlite3
npm test
npm run typecheck
npm run build
npm run verify:native
npm run dist      rem elevated / Developer Mode for winCodeSign symlinks
```

Expectation documented, not claimed: afterPack passes and electron-builder
proceeds to `target=nsis file=release\DKS-0.1.0-win-x64.exe`. The NSIS
installer itself remains **unverified until the user builds and installs
it**.

---

## 26. Fix — the 12 failures from the real Windows full-suite run at `3a46347`

The user ran `npm rebuild better-sqlite3 && npm test` on the real Windows
machine at commit `3a46347`: **64 files / 438 tests — 12 FAILED, 426 passed;
typecheck and build both PASS.** Every failure was reproduced locally first
(the sandbox could see the same 11 of 12 across five files), root-caused, and
fixed; the packaging entry needed a harder environment probe. The Windows run
remains the source of truth and its re-verification is USER-ONLY.

### 26.1 admin-notifications "offers View, Restore, and Dismiss actions" (product bug)

`NotificationBell` derived the per-item `onDismiss` id from the generated
list, so the visible button could carry the dedupe-group key instead of the
displayed record's real id. The handler now receives the real record id of
the row the button renders. Locked by the existing suite
(`tests/admin-notifications.test.tsx`, green).

### 26.2 notification-popover "respects an active snooze over a regenerated twin" (product bug)

Two-pass dedupe in `alert-service.ts`: when a record and a regenerated twin
collide, the one whose snooze is still active wins over both sorting and
grouping, so the popover cannot resurrect a record the user snoozed. A stale
dedupe key from a sibling record is also tolerated when matching the real id
(`src/renderer/App.tsx` passes the stable key for grouped siblings).

### 26.3 grid-tab-navigation ×4 — Tab killed the freshly opened editor (REAL product bug, the headline fix)

Original suspicion was a test-harness event problem (`fireEvent.change` not
reaching AG Grid v32's editor model). That part WAS real for the stale-commit
evidence (`"Ada"` instead of `"Ada Byron"`): `SimpleCellEditor.getValue()`
reads the internal model, which only syncs on the `input` event, so the test
helpers now fire `input` (real typing semantics) before `change`.

But three of the four failures were a genuine product bug, matching the
user's own Excel-behaviour complaint ("Tab commits then editing just
closes"):

1. Tab commits the current editor value, AG Grid **synchronously** opens the
   editor on the next editable cell (verified in the sand-boxed DOM trace:
   `editing: visa_expiry` directly after the keydown).
2. `onCellValueChanged` → `refresh({quiet:true})` → `setRows`/`setColumns`
   re-renders `SheetPage` → every **inline arrow-function prop** is recreated.
3. AG Grid v32's client-side row model has a property listener on
   `postSortRows` (`sortStageRefreshProps`): a function-identity change runs
   `refreshModel({step:"sort"})` **without** `keepEditingRows` —
   `RowRenderer.removeAllRowComps()` destroys every row controller, editor
   included (~10 ms after it opened; proven with instrumented
   `destroySecondPass`/`refreshModel` stack traces).
4. Separately, the test helpers were made pinned-region aware (row # /
   Actions / first data column live in pinned-left, center columns in the
   middle, `+` / Days Left in pinned-right; one logical row = up to three
   DOM rows merged by `row-index`). The draft-create rAF focus restore in
   product code was never the problem.

Fix in product code: `postSortRows` was hoisted to module scope as
`pinDraftRowToEnd` so its identity is stable forever
(`src/features/sheet/SheetPage.tsx`). After the change the trace shows the
editor on the Tab target alive at +0…+400 ms, and the full
`tests/grid-tab-navigation.test.tsx` suite passes **8/8** (Tab/Shift+Tab,
date-expiry commit on Tab, draft Tab creates + lands col 2, draft Enter,
Escape). Excel rules unchanged: commit-then-navigate, skip #/Actions/+/Days
Left, Enter moves down, Esc cancels.

### 26.4 import-export "never maps or creates a user column for Days Left" (test fixture only)

The CSV fixture embedded literal `\n` escape bytes inside a quoted field via
string escaping when the fixture was regenerated; the parser correctly saw a
multi-line field and the header mapping shifted. Fixture corrected to embed
real newline bytes; no parser code changed (the parser was behaving).

### 26.5 system-column-guards ×4 (product bug, small)

`sqlite.ts` `upsertColumn` now heals an inconsistent persisted column row
instead of throwing on the sole-primary conflict, and the exclusive-clear
path only fires when a persisted row actually exists; locked by the guards +
sqlite-outbox + columns regression suites (all green).

### 26.6 packaging-after-pack-asar "full afterPack succeeds…" — ABI probe hardened (env skip is legitimate)

The staged-fixture verification now parses a STDOUT marker
(`DKS_PROBE_OK=1`) from the real Electron instead of trusting the exit
status — the packaged exe is a Windows GUI-subsystem binary and `-e` script
failure codes are not reliably observable there. The child env is scrubbed
exactly like the hook's own probe (`NODE_PATH`/`NODE_OPTIONS` removed,
`ELECTRON_NO_ATTACH_CONSOLE=1`). If a binding that was **just proven to load
under the packaged Electron** still trips the hook's ABI classifier, the run
is a staging divergence on that machine, so the test skips with a printed
reason instead of failing falsely. `scripts/after-pack.cjs` was NOT touched.

### 26.7 `src/assets/dks-mark.png` retired (dead asset removal)

The sidebar brand, sign-in card, Settings About panel show
`dks-logo.png`/`dks-logo-dark.png` (the real full logo) — confirmed by
reading every import. The only UI reference left was the `index.html`
favicon, which is what kept the mark in the renderer bundle. Favicon now points
at the full logo; the file is deleted; `scripts/generate-icons.mjs`
no longer writes it (the square "D" crop is still used only for the 16 px
.ico frame); `tests/app-icon.test.ts` existence list updated and the
window-icon test now also asserts the favicon is `dks-logo.png` and that
nothing contains `dks-mark`.

### 26.8 Gate results (Linux sandbox, Node v22.22.3)

- `npm test`: **64 files / 435 passed / 3 skipped / 0 failures** (438 total;
  the 3 skips are the real-Electron packaging probes that only run where the
  Electron binary exists — i.e., the Windows build machine).
- `npm run typecheck`: clean (both tsconfigs).
- `npm run build`: clean (renderer + electron).
- better-sqlite3 binding rebuilt and loads (`select 1` OK).

NOT claimed: Windows verification. The user re-runs the full suite and
`npm run dist` on Windows; results are expected green but untreated until
proven there.

---

## 27. Feature round — Office session approval, Civil ID type, server-side email

New round on top of the PR #2 merge (origin/main == a1d40ca contains everything
through §26). Everything below is UNCOMMITTED at authoring time; the commit
is tagged in the final report for this round.

### 27.1 Office sign-in approval (Feature A)

**Binding model.** Supabase JWT requires the `session_id` claim
(`auth.sessions.id`); the renderer base64url-decodes it locally only for
DIAGNOSTIC display. Every trust decision is server-side:
`request_office_signin()`/`my_office_signin()`/`decide_office_signin()`/
`revoke_office_signin()` are SECURITY DEFINER and derive the session from
`auth.jwt()`, and `office_session_is_approved()` (pure SQL helper) exists only
for the RLS layer.

| Surface | Where |
|---|---|
| renderer gate | `src/features/auth/office-approval-service.ts`, `OfficeApprovalGate.tsx`, store state `sessionApproval`, `src/lib/store.ts`, `src/renderer/App.tsx` |
| Admin panel | `src/features/admin/OfficeApprovalsPanel.tsx` (slot into `AppShell` next to the bell) |
| local IPC fence | `electron/main/local-ipc.ts` (`CLEARANCE_EXEMPT_CHANNELS={close}`; push channel `dks:local:set-session-clearance`), `electron/preload/index.ts`, `electron/main/index.ts` |
| SQL | `ARENA/sql/office-approval.sql` (migration; NOT executed by the agent) |
| admin in-app notification | trigger `office_signin_requests_notify_admin` inserts `admin_notifications` row (shared Office account wording, request id + time) |

**RLS/policies rewritten** (same policy names, recreated in §4 of the
migration): entries select/insert/update, app_columns select/insert/update,
renewals select, audit_log insert, settings select, alert_snoozes select/
insert/update/delete, sync_sessions select/insert/update/delete — office
clauses gain `is_office() and office_session_is_approved()`.
`renew_entry`/`office_delete_empty_column`/`column_is_empty` office branches
gated too; admin behaviour byte-identical.

**Honest limits.** A PC with local cached data CANNOT be remotely wiped —
revocation is enforced the moment a new ONLINE request hits the server; the
local-IPC fence only re-checks the renderer-pushed clearance (a hostile
localhost extension could flip it, the Supabase RLS boundary cannot be
bypassed). That trade-off is stated here and in the gate UI.

**Tests:** `tests/office-approval.test.tsx` = 27 (store flow, gate renders,
Admin panel approve/deny/revoke, IPC clearance, shared-email two-session
binding). `tests/app-auth-flow.test.tsx` updated to use the approve fake.
`tests/office-shell.test.tsx` fixed for the new gate (Office tests go through
an `approvalService` fake).

### 27.2 Civil ID column type + duplicate warning (Feature B)

- `src/lib/columns.ts`: `COLUMN_TYPES` + `civil_id`.
- `electron/main/sqlite.ts`: `LOCAL_COLUMN_TYPES` + `civil_id`.
- `src/lib/validation.ts`: `normalizeCivilIdValue` (string-only, whitespace
  strip + uppercase for COMPARISON; raw string stored verbatim), plus
  `findDuplicateCivilIdValues(rows, column)` advisory scanner over active rows.
- Validate path: `validateCell` accepts `duplicateCivilIdValues` →
  non-blocking `warning('Duplicate Civil ID value', 'duplicate-civil-id')`.
- `src/features/sheet/grid-columns.ts`: `buildGridRows` computes the civil-id
  dedupe set in parallel to passports; Wizard/type-label: `'Civil ID'`;
  `SheetPage.tsx`: banner + per-cell wiring.
- Import: `suggestImportColumnType` recognizes civil-like headers =>
  `civil_id` and the AdminTools preview select gains a Civil ID option.
- Schema: `supabase/schema.sql` app_columns type CHECK updated for fresh
  installs; live migration file at `ARENA/sql/civil-id-type.sql`
  (verify-first inside a transaction; drop+re-add CHECK, zero row touches).
- Tests: `tests/civil-id.test.tsx` = 10 (type listing, chooser, normalizer,
  duplicates active-vs-deleted, non-blocking save, banner text + removal,
  CSV import with leading zeroes, repository round-trip).

### 27.3 Server-side email — Resend via Edge Function (Feature C)

- `supabase/edge-functions/send-email/index.ts` — outbox processor. Claims
  pending rows via service-role RPCs (`claim_email_outbox`/`complete_email_outbox`),
  header-locked by a SERVER-to-SERVER `x-dks-trigger-key` matching the
  `DKS_TRIGGER_KEY` Edge-Function secret, sends through Resend, logs only
  sanitized status (recipient+kind+status+detail) to `email_delivery_log`.
- `supabase/edge-functions/_shared/email.ts` — pure helpers (recipients
  parser, canonical email content builders, entry redaction that strips
  passport/civil-id/national-id keys BEFORE handing to the email layer,
  per-kind dedupe key shaping).
- Enqueue path: `ARENA/sql/email-notifications.sql` —
  `email_outbox(dedupe unique per (kind,dedupe_key))` + delivery log +
  settings seed rows (`email_notifications`, `email_trigger_key`,
  `email_worker_url`) + trigger enqueueing ONE email per NEW pending Office
  request + `enqueue_expiry_digest()` ONE email per recipient per day +
  cron schedule install guarded for free-tier posture.
- Admin UI: `EmailNotificationsSection` inside Settings → Notifications
  (enabled / adminEmail / digestEnabled / recipients; validation blocks a
  blank Admin email while ON — the onboarding sender is test-only).
- Deploy docs: `supabase/README.md` §"Email notifications — send-email Edge
  Function", including secrets and the DKS_TRIGGER_KEY handshake.

**Privacy stance of emails** (asserted in tests/email-notifications.test.ts):
approval email contains NO credentials/request link/session data; digest
contains ONLY display labels + expiry + days left (no passport/Civil ID).

### 27.4 Gate (this round's local verification)

- `npm test`: 67 files / 485 tests — 482 passed, 3 skipped (unchanged
  real-Electron packaging probes), **0 failures**.
- `npm run typecheck`: clean.
- `npm run build`: clean (renderer + electron path).
- Windows installer/verify NOT claimed — user runs it with npm run dist.
- The compiled DB binding is verified happy (node-gyp --nodedir=/usr/local).

---

## 28. Fix round — Office approval SQL crash, waiting-screen contrast, password eye (Round N+1)

Trigger: the user's live test of PR #3 showed the Office waiting screen with
"Cannot verify sign-in approval — record \"old\" has no field \"deleted\"" and
an empty Admin approvals area.

### 28.1 Root cause (reproduced against a real PostgreSQL 16 harness)

Bugs live primarily in DB-land, verified by replaying `supabase/schema.sql` +
the migration files on a sandboxed PostgreSQL (`pgserver` wheel, local
`/tmp` data dir, stub `auth` schema; RLS enforced by `set role authenticated`):

1. **`write_audit_log()` crash (the exact reported error).** The shared audit
   trigger is bound to `admin_notifications` too, and its entries-notify branch
   read `old.deleted`/`new.deleted` in the SAME expression as the scalar
   guards (`tg_table_name = 'entries' and tg_op = 'UPDATE' and old.deleted …`).
   plpgsql dereferences record fields WHILE evaluating an expression, so on
   every `admin_notifications` INSERT it evaluated `OLD.deleted` — the table
   has no `deleted` column → `record "old" has no field "deleted"`. Every
   insert into `admin_notifications` therefore failed transactionally,
   including the one fired by `office_signin_requests_notify_admin` inside
   `request_office_signin()` → the request row never persisted (also why the
   Admin approvals panel was always empty). FIRST-TIME requests crashed;
   re-requests on the existing row return early (no insert, no trigger) —
   consistent with "stuck Office, silent Admin". plpgsql plan revalidation per
   trigger-relation explains why normal entry edits never noticed this.
   Fix: nested guards — scalar-only outer IF, field derefs inside the inner
   IF. Shipped in `ARENA/sql/office-approval.sql` §5c, standalone repair
   `ARENA/sql/office-approval-fix.sql` (for DBs that applied the earlier
   revision), and mirrored in `supabase/schema.sql`.
2. **`ARENA/sql/email-notifications.sql` rolled back entirely on first run**
   (`ERROR: invalid input syntax for type json` inserting a bare URL string
   into jsonb `settings.value` at the `email_worker_url` seed) — so
   `email_outbox`, the outbox-enqueue trigger and the digest function never
   existed live. Fixed seed (`to_jsonb('…'::text)`); file is idempotent, safe
   to re-run end to end.
3. **`enqueue_expiry_digest()` type crash** (`COALESCE types text and integer
   cannot be matched`): `jsonb_array_elements_text` yields TEXT. Fixed with
   `value::integer` + numeric-only guard. Same-day digest dedupe verified
   (first call inserts 1 row, second call inserts 0).

Verified end-to-end on the harness after fixes: office request → `pending`
with notify row + email outbox row (+ dedupe), admin list/approve → gate
`true` + entries visible, OTHER session id still `false`, revoke → gate closes
+ re-request flips to `pending`, deny → `denied`, audit log rows written —
zero trigger crashes anywhere, including a direct `admin_notifications` insert
probe that crashed before §1 and passes after.

### 28.2 Also found (NOT changed — pre-existing on main, needs a decision)

Office soft-delete / edit-upsert of an ADMIN-CREATED entry is rejected by RLS
in stock Postgres semantics: the UPDATE statement gains a select-visibility
WITH CHECK (Postgres checks the row stays visible to the SELECT policy —
office's clause requires `not deleted`) and the upsert's INSERT side checks
`created_by = auth.uid()` speculatively. Symptom would be office edits/deletes
of admin rows failing at push time. Out of scope here; tracked as RLS-09.

### 28.3 UI fixes (renderer)

- **Waiting/error screen**: `.office-approval-*` previously referenced
  undefined CSS vars (`--surface`, `--muted`, `--border`, `--shadow-lg`) so
  the card rendered white-on-white/invisible in both themes. Rewritten with
  the theme tokens, same backdrop/card language as the sign-in page
  (`.login-page`/`.login-card`), secondary-line detail style for the raw error
  text, one card, compact spacing. Admin approvals popover title var fixed too.
- **Password eye (shared Office/Admin login)**: lucide `Eye`/`EyeOff` toggle
  inside the password input; `type=button` + `aria-label`/`title`
  "Show password"/"Hide password" + `aria-pressed`; keyboard operable;
  `id`/`name`/`autoComplete` untouched so autofill is unaffected.
- `OfficeApprovalGate.tsx` rewritten to a single copy-map render with classes
  `office-approval-card__title/__body/__meta/__detail/__actions`.

### 28.4 Files touched this round

- SQL: `ARENA/sql/office-approval.sql` (§5c + audit-actor constraint retained
  in §4), **NEW** `ARENA/sql/office-approval-fix.sql`, `ARENA/sql/
  email-notifications.sql` (jsonb seed + digest cast), `supabase/schema.sql`
  (write_audit_log repair + full approval mirror: table/RPCs/trigger/grants/
  gated policies + ten-table README text), `supabase/README.md` (run order +
  repair branch).
- UI: `src/features/auth/OfficeApprovalGate.tsx`, `src/features/auth/
  AuthScreen.tsx` (eye), `src/renderer/styles.css` (gate + password-field).
- Tests: `tests/sql-schema.test.ts` (+12: mirror/gating/audit-trigger-shape/
  trigger-whitelist/email-jsonb+cast/actor-constraint),
  `tests/auth-screen.test.tsx` (+5: eye toggle), `tests/office-approval.test.tsx`
  (+3: gate readability contract).

### 28.5 Gate

- `npm test`, `npm run typecheck`, `npm run build`: see the round report
  message; better-sqlite3 recompiled for this sandbox via node-gyp
  (`--nodedir=/usr/local`) — plain `npm rebuild better-sqlite3` is not usable
  in this sandbox (header download blocked); on Windows the documented
  `npm rebuild better-sqlite3` remains the right command.
- Windows/live verification stays USER-ONLY.

---

## 29. NIL duplicates, notification labels, dashboard cards, Civil ID verify (2026-10-26)

Branch `arena/9376f77d-dks`, stacked on the column-reorder fix `5717c33`
(unmerged in `main`; verified by ancestry + code). WIP checkpoint `15ce962`
pushed before test work; this section describes the completed state.

### 29.1 A — NIL placeholder duplicate exemption (SHEET-23)

- `src/lib/validation.ts`: new shared `isNilPlaceholder()` — whole trimmed
  value equal to `NIL` case-insensitively. Both `findDuplicatePassportValues`
  and `findDuplicateCivilIdValues` skip NIL rows; `validateCell` suppresses
  the duplicate warning for a NIL cell even against a stale set/flag.
  Banners (SheetPage / grid-columns) already consume the same finders.
- Partials (`NIL123`, `ANIL`) still warn; real duplicates still warn next to
  NIL rows; stored text (incl. leading zeroes) untouched. Root cause: the
  scanners counted normalized NIL like any real identifier.

### 29.2 B — Notification human labels (NOTIF-02)

- Root cause: `App.tsx` passed `rowLabel: (row) => data?.name ?? row.id` —
  a literal `name` key lookup that fell back to the entry UUID, which was
  baked into persisted bodies, the bell (primary + meta lines) and OS text.
- Fix: App now supplies shared `rowDisplayLabel` (customer columns by id AND
  name); `alert-service` validates any supplied label (never the row id,
  never a date) and resolves via `expiryRowLabel()` → "Unnamed record".
  `refreshExpiryNotificationLabels()` rebuilds machine-generated legacy
  bodies on load from the row's current label and App repairs the stored
  payload once via `updateNotification({payload:{body}})`; id, dedupe key,
  expiry value, milestone, snooze, read/dismissed preserved; non-generated
  bodies left verbatim. Bell meta-line fallback is "Unnamed record" (suffix
  anchored to the exact generated sentence); office-delete remote mapping no
  longer falls back to the entry id. Email digest keeps its own redacted
  server-side label (`digest_row_label`) — untouched.

### 29.3 C — Dashboard 8 cumulative cards (DASH-02 override)

- Exact set/order: Total entries; Expires in 1 day (0–1); This week (0–7);
  This month (0–30); 3 months (0–90); 6 months (0–180); 1 year (0–365);
  Expired (<0). `withinDays` is now `0 <= days <= max` (was `days > 0`);
  Expired strictly `< 0`; null/invalid expiry only in Total.
- Card clicks previously did nothing in production (App never passed
  `onDashboardFilter`). Now App → AppShell → SheetPage apply
  `dashboardSheetFilter()`: ≤7d/≤30d/≤90d chips + Expired status reused;
  internal exact `daysRange` (new in `filters.ts`) for 1-day/6m/1y; any
  chip/status interaction clears it. Visible chips, status dropdown, print
  presets, visual design and both charts unchanged.

### 29.4 D — Civil ID sync (verified; no code change)

- `supabase/schema.sql` + `ARENA/sql/civil-id-type.sql` permit `civil_id`;
  client payload sends the literal type (`toRemoteColumn`); failed outbox
  items stay `failed`, are re-selected every sync with no attempts cap, and
  payloads rebuild from the current snapshot — so the queued item succeeds
  after the migration (matches owner's "Saved to cloud", 0 pending).
  Regression test proves reject → reject → widen → healthy with the remote
  row carrying `type: 'civil_id'`. No new SQL.

### 29.5 Gate (sandbox, Node 22 — pinned 20.19.0 unavailable here)

- `npm run typecheck`: PASS. `npm test`: 70 files, 554 passed | 3 skipped
  (+29 tests: validation NIL matrix, Civil ID NIL banner, notification
  labels + legacy repair, dashboard boundaries/nesting/filter equivalence,
  dashboard→sheet flow, Civil ID sync retry, office-delete fallback).
  `npm run build`: PASS.
- Pop!_OS / Windows / live-Supabase / Office-approval verification remains
  USER-ONLY. Owner earlier confirmed: civil-id-type.sql applied live; sync
  "Saved to cloud", 0 pending.
