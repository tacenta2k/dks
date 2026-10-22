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
- `ARENA/WINDOWS_STARTUP.md` documents the single mechanism, read-only
  PowerShell inspection commands, how to identify a DKS entry from its command
  path, and safe manual removal steps.

Honest limits: the two `Aswin` entries cannot be attributed to DKS from this
environment — their command paths must be read on the user's PC (see the
read-only commands in `ARENA/WINDOWS_STARTUP.md`). The separate `utweb`
registry entry is unrelated and is not touched. No registry entry, startup
setting or shortcut is modified by the app or by this work.

Tests: `tests/startup.test.ts` (6) — packaged registration points at the real
exe and never hides the window, a development run registers nothing, an
unsupported platform is not faked, and the tree keeps exactly one mechanism
(no `auto-launch` dependency or client).
