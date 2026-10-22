# DKS — Session Progress (Agent)

Session branch: `arena/0e0155c1-dks` (PR #1 open, kept open).
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

## 3. Tracking files
- `ARENA/TO_DO_LIST.md` — single implementation checklist (9 groups, stable IDs).
- `ARENA/ARENA_PROGRESS.md` — this file (session progress + confirmed items).
- No new requirement docs were created; the three source docs were not edited.

## 4. Current work (in progress)
- [x] Entries RLS insert authorization (CRIT-01) — implemented + regression test.
- [x] `ARENA/TO_DO_LIST.md` + `ARENA/ARENA_PROGRESS.md` created.
- [ ] Full gate (rebuild + test + typecheck + build) before committing the RLS fix.
- [ ] Commit RLS fix (message: `fix: allow authenticated entry sync under entries RLS`).
- [ ] UI batch 1: Global shell & navigation (SHELL-*).
- [ ] UI batch 2: Visa Sheet structure (SHEET-01..16).
- [ ] UI batch 3: Dashboard / Recycle Bin / Audit Log layouts.
- [ ] UI batch 4: Settings & dialogs, responsive, verification cleanup.

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
