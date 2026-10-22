# DKS — Implementation Checklist (single source of truth)

Built from `HANDOFF.md`, `docs/RESUME_NEXT_SESSION.md`, and `docs/FIXES_UI.md`.
This is the single implementation checklist for the current session. Status is
tracked in `ARENA/ARENA_PROGRESS.md`.

Status legend:
- `CONFIRMED_BY_USER` — verified working in the packaged app by the user.
- `IMPLEMENTED_AWAITING_CONFIRMATION` — implemented, tests pass, committed;
  needs user verification in the packaged app.
- `NOT_STARTED` — not yet implemented.
- `BLOCKED` — waiting on a user-only action (SQL, packaging, secrets).

Round-3 user overrides (latest decisions — these win over anything older):

- **Actions column stays.** It must not be removed; its duplicate / delete /
  renew controls must be small, aligned, accessible icon buttons with tooltips
  that sit fully inside each row.
- **Dashboard is approved ("perfect").** No visual changes to it, ever, in this
  round.
- **Visa Sheet fills the whole available content width and height** — no
  centered max-width wrapper and no wide empty margins (verify at 1920px and at
  a narrower window).
- **Draft row sits immediately after the last saved record**, with visible
  grid/cell borders. When a value is committed, that row becomes a saved row
  and a new blank draft appears directly beneath it. This supersedes the
  earlier "pinned to the bottom of the viewport" proposal.
- **The `+` column header stays.** Add Row / Add Column / Manage Columns toolbar
  buttons stay removed.
- **Notification popover:** no custom date snooze; expiry items get Mark read
  plus only snooze choices that do not exceed the time remaining; an action
  updates the item in place and must not make the popover disappear.
- **The three handoff/spec files (`HANDOFF.md`, `docs/RESUME_NEXT_SESSION.md`,
  `docs/FIXES_UI.md`) are never edited.**

Locked decisions that resolve conflicts (later decisions win):
- No backups of any kind.
- No passport-format validation (plain text; non-blocking duplicate warning only).
- No hard-coded Category / Visa Type / Notes / Country columns; no "Load Visa Template".
- No Actions column in the final UI (row ops move to right-click menus / context).
- Excel-like sheet per `docs/FIXES_UI.md` (row numbers, `+` column, draft row, frozen Days Left).
- Admin/Office permissions remain enforced (RLS + service/IPC + renderer).

---

## 1. Critical blockers

| ID | Source | Requirement | Type | Status |
|----|--------|-------------|------|--------|
| CRIT-01 | RESUME B3 / task / R2-01 | Entries RLS: any authenticated account may INSERT (own `created_by`), and **either account** may UPDATE any live row — including a soft delete (`deleted=true`) of a row created by the other account. Office cannot update an already-deleted row; restore stays admin-only via `restore_entry()`; hard DELETE stays admin-only. `created_by` is immutable (BEFORE UPDATE trigger). Client stamps `created_by` on INSERT only and `updated_by` on UPDATE. SQL: `ARENA/sql/fix-entries-rls.sql` (user runs it) + `supabase/schema.sql` for fresh installs; RLS stays on, no anon grants, no service-role. Failed sync keeps the local row + sanitized reason; outbox `attempts` now increments. | Functional | IMPLEMENTED_AWAITING_CONFIRMATION (SQL must be run by the user) |
| CRIT-02 | RESUME B2 | Recycle Bin permanent delete must work (was `ensureOpen` IPC crash). Admin authz enforced in IPC/service; audit entry recorded; Office rejected. | Functional | CONFIRMED_BY_USER |
| CRIT-03 | RESUME B1 | CSV/Excel export must not produce blank files; include header, visible columns, Days Left, filtered rows, DD/MM/YYYY. Import end-to-end verified. | Functional | CONFIRMED_BY_USER |
| CRIT-04 | RESUME B3 | Sync must drain pending outbox to healthy without duplicates or silent loss; surface a meaningful (sanitized) error per operation. | Functional | CONFIRMED_BY_USER |

## 2. Global shell and navigation

| ID | Source | Requirement | Type | Status |
|----|--------|-------------|------|--------|
| SHELL-01 | FIXES_UI 3.1 | Compact top bar (~48–52px) on every authenticated page: [☰] page title … [Sync] [Bell] [Theme] [Avatar]. No search/filters/import/export/print/breadcrumbs/email/logout in the top bar. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHELL-02 | FIXES_UI 3.2 / R2-12 | Global sync status in top bar from real outbox state (Saved to cloud / Syncing… / Offline — saved locally / Sync error); pending count; click/Esc opens popover with pending count, last sync time, sanitized error. Never a decorative label; never green on error. R2-12: with any pending/failed item the pill reads "Sync error · N pending" (or "Syncing… · N pending") and never "Saved to cloud". | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHELL-03 | FIXES_UI 3.3 / R2-02 | Notification bell icon with unread badge; floating popover (Esc/outside close); role-gated alerts (Office: expiry only; Admin: + Office-deletion alerts); no inline top-bar text. R2-02: one identical clean popover for both roles — title + unread count, one-line message, secondary "record · date", one compact button row, no bullets/native date input/custom snooze; snooze choices limited by days left; admin deletion alerts keep View · Restore · Dismiss; the popover stays open and the badge updates immediately. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHELL-04 | FIXES_UI 3.4 / R2-07 / R2-08 | Theme icon-only toggle (moon/sun, tooltips); one click switches; personal/per-PC; all grids/charts/dialogs follow theme. R2-07: AG Grid switches to ag-theme-quartz-dark with token overrides and the Recycle Bin / Audit Log tables have explicit dark rules (no white panels). R2-08: a personal theme choice always wins; saving Settings no longer re-themes the session and the workspace default applies only to a new sign-in with no saved personal preference. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHELL-05 | FIXES_UI 3.5 | Profile avatar popup: actual email + actual role + Log out; Esc/outside close; no pending-change discard on logout. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHELL-06 | FIXES_UI 4 | Collapsible sidebar (≈220px expanded / ≈56px collapsed) with logo + distinct icons + selected state + tooltips; toggle via ☰; state persists across restart; Office sees only Dashboard + Visa Sheet; no Workspace-health/STEP footer box. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHELL-07 | FIXES_UI 2 | Remove breadcrumbs, subtitles, eyebrow labels, developer STEP text, top-bar email, standalone Log out, "Theme: X" text control, inline notification content, "Offline-first" pill, sidebar health footer, Export Data on Dashboard/Settings. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHELL-08 | HANDOFF / FIXES_UI 1 / R2-11 | Consistent light+dark theming; no UUIDs/raw JSON/raw ISO timestamps in normal UI; visible dates DD/MM/YYYY; visible datetimes DD/MM/YYYY HH:mm (Asia/Muscat). R2-11: Office and Admin share the same shell (sidebar, top bar, sync pill, bell popover, avatar); Office only has fewer nav items and no admin actions; the old Workspace-health box and the old inline notification UI are gone. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |

## 3. Visa Sheet

| ID | Source | Requirement | Type | Status |
|----|--------|-------------|------|--------|
| SHEET-01 | FIXES_UI 5.1 / R2-09 | Layout: top bar + one compact toolbar + grid filling remaining width/height; no big title/subtitle/centered card; grid scrolls internally; horizontal scroll allowed. R2-09: the centered 1280px wrapper and wide padding are removed; the sheet occupies 100vh - 50px and the grid fills the rest. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHEET-02 | FIXES_UI 5.2 / R2-04 / R2-09 / R2-15 | One-row toolbar: Search / Status ▾ / Today ≤7d ≤30d ≤60d ≤90d / Group by ▾ / Tools ▾ (Admin). Single-select chips; combine logically; expired only via Status. R2-04 (user decision): Expired and No-expiry chips removed; final status list in SHEET-03. R2-09: Add row / Add column / Manage columns removed. R2-15: below 1080px the ≤60d and ≤90d chips move into `More filters ▾` (search shrinks first) so the toolbar stays one row. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHEET-03 | FIXES_UI 5.2 / R2-04 | Status dropdown (final, user decision): All statuses / Valid / Expiring soon / Expired / No expiry. "Expiring soon" = every non-expired row with 0 <= Days Left <= the expiring-soon threshold. Urgent/Expires today remain row colours + Days Left badges only. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHEET-04 | FIXES_UI 5.2 / R2-13 | Group by lists only existing user Text/Dropdown columns + None; hidden when none; group headers inside grid (not export/data rows); Community-compatible impl. Implemented with synthetic full-width header rows (groupGridRows); no Enterprise row grouping. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHEET-05 | FIXES_UI 5.2 | Tools menu Admin-only (Import / Export CSV / Export Excel / Print-PDF); fully absent for Office; Print/PDF opens selection dialog; role also checked in service/IPC. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHEET-06 | FIXES_UI 5.3 | Grid: row-number gutter pinned left; sticky header; freeze first data column; click-to-sort with indicator; drag-reorder + resize + double-click autofit; no Enterprise APIs. | UI | IMPLEMENTED_AWAITING_CONFIRMATION
| SHEET-07 | FIXES_UI 5.3 | Days Left: always final column, pinned right, locked, never editable/deletable/reorderable; stronger status color. Primary expiry header shows ★. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHEET-08 | FIXES_UI 5.3 | Compact row height ~30–34px; 13–14px text; subtle 1px lines; truncate with … (full on hover/editor); whole row lightly tinted by status; readable on tint/selected. | UI | IMPLEMENTED_AWAITING_CONFIRMATION
| SHEET-09 | FIXES_UI 5.4 / RESUME F2 | Date cells: DD/MM/YYYY display; progressive slashes while typing; normalize paste; date picker; invalid-date warning (no silent rewrite); date-only (no TZ shift); real Date columns only. | Functional+UI | CONFIRMED_BY_USER |
| SHEET-10 | FIXES_UI 5.5 | `+` column header (≈44–48px) pinned before Days Left; label "Add column"; opens Column Setup; no sort/filter/drag/menu; blank body cells; excluded from exports; no A/B/C row. | UI | IMPLEMENTED_AWAITING_CONFIRMATION
| SHEET-11 | FIXES_UI 5.6 / R2-09 | Draft row: one blank row pinned bottom, always visible; no number until real; focus alone creates nothing; first meaningful committed value creates exactly one row; 0/false meaningful; no row per keystroke; fresh draft after save; continuous focus; Esc cancels; no row actions; excluded from counts/notifications/exports/print/sort/sync. Implemented via pinnedBottomRowData + isMeaningfulDraftValue; replaces the removed Add row button. | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHEET-12 | FIXES_UI 5.7 / R2-09 | Editing/keyboard: click-type, F2/dbl-click edit; Enter commits+down; Tab right; Esc cancel; Delete clears cell only; Ctrl+C/V (Community); paste plain; Ctrl+Z/Y where available; system cells never editable. Explicit contract in GRID_KEYBOARD_PROPS, covered by tests. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHEET-13 | FIXES_UI 5.8 / R2-09 | Right-click column menu: Rename / Duplicate column / Delete column (+ Admin "Set as Primary Expiry" on Date-Expiry); no Hide; no menu on Days Left/+ /system columns; duplicate copies name/type/options not values, "Original (copy)"; delete confirms; server checks populated; Office deletes only empty; Admin deletes populated after strong warning. Replaces the removed Add column / Manage columns buttons. | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHEET-14 | FIXES_UI 5.8 | Right-click row menu: Mark as Renewed / Duplicate row / Delete row / Snooze alert; from row number or cell; renewal needs usable primary; duplicate copies values not id/deletion/audit/renewal/snooze; delete = confirmed soft delete; snooze only where relevant; no menu on draft row. | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION
| SHEET-15 | FIXES_UI 5.9 | One context-aware empty state at a time (no columns / columns no entries / no filter matches); never both grid+app empty text; never cover `+` or draft row. | UI | IMPLEMENTED_AWAITING_CONFIRMATION
| SHEET-16 | FIXES_UI 2 / R2-09 | Remove: Add Row / Add Column / Manage Columns toolbar buttons, Group-by-Category button, Load Visa Template, Category filter, "Uncategorized · N" chip, hide/unhide column, passport checkbox, country passport validation UI, big Admin Tools card, separate Export buttons. Done. USER DECISION (R2-09): the compact icon-only Actions column is deliberately kept (overrides the "no Actions column" item for this one control only). | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHEET-17 | RESUME F1 | Passport plain text; no format validation/invalid styling; remove wizard checkbox; keep non-blocking duplicate warning. | Functional | CONFIRMED_BY_USER |
| SHEET-18 | RESUME F3 | No hard-coded business columns/template; keep generic types (text, number, phone, email, price, date_start, date_expiry, dropdown, checkbox, notes). | Functional | CONFIRMED_BY_USER |
| SHEET-19 | HANDOFF / task | Grid typing/focus must not lag or lose focus (remount regression). | Functional | CONFIRMED_BY_USER |
| SHEET-20 | HANDOFF / RESUME | Days Left computed from Primary date_expiry + local date; locked final column; recomputed on expiry/primary/date change. | Functional | CONFIRMED_BY_USER |
| SHEET-21 | HANDOFF | 5 statuses: Valid (>90d), Expiring Soon (30–90d), Urgent (1–29d), Expires today (0d), Expired. | Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SHEET-22 | HANDOFF | Multiple expiry columns allowed; one Primary Expiry; only Admin chooses/changes primary; Office can edit expiry values. | Functional | IMPLEMENTED_AWAITING_CONFIRMATION |

## 4. Dashboard

| ID | Source | Requirement | Type | Status |
|----|--------|-------------|------|--------|
| DASH-01 | FIXES_UI 6 | Remove duplicate heading/subtitle/Offline-first pill/Export Data; use full width; avoid large blank margins. | UI | IMPLEMENTED_AWAITING_CONFIRMATION
| DASH-02 | FIXES_UI 6 | Cards row 1: Total Entries, Expired, Expiring Today, This Week, This Month; row 2: Within 2/3/6 Months, Within 1 Year. Compact (~80px); emphasize Expired/Today; reflow small; clickable → Visa Sheet with matching filter; exclude soft-deleted + draft; Primary Expiry only. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| DASH-03 | FIXES_UI 6 | Charts: left (~40%) Expiry Status donut + legend/counts; right (~60%) Next 12 Months bar; stack on small; mutually-exclusive status categories; no invented status; empty state "No expiry data yet". | UI | IMPLEMENTED_AWAITING_CONFIRMATION |

## 5. Recycle Bin

| ID | Source | Requirement | Type | Status |
|----|--------|-------------|------|--------|
| RBIN-01 | FIXES_UI 7 | Layout: top-bar title; compact search/count toolbar; full-width table; no big header/breadcrumb/subtitle/Admin-tools label. | UI | IMPLEMENTED_AWAITING_CONFIRMATION
| RBIN-02 | FIXES_UI 7 | Toolbar `[Search deleted records…]  N items` (+ truthful retention wording: auto-purge vs "kept until permanently deleted"). | UI | IMPLEMENTED_AWAITING_CONFIRMATION
| RBIN-03 | FIXES_UI 7 | Table columns Record / Passport No (if available) / Expiry / Deleted / Purge in (if active) / Actions; resolve friendly Record label (else "Untitled record"); never raw UUID; omit inapplicable columns; Expiry DD/MM/YYYY; Deleted DD/MM/YYYY HH:mm; newest first; sticky header. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| RBIN-04 | FIXES_UI 7 | Short [Restore] [Delete] buttons (no full name appended); prevent duplicate clicks; failure stays visible; confirmations for restore + permanent delete; empty states. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| RBIN-05 | RESUME S2 | Recycle Bin shows row label (not `row-…`), local DD/MM/YYYY HH:mm deletion time, clear Restore/permanent-delete with confirmation, and "Deleted by" when known. | Functional+UI | CONFIRMED_BY_USER |

## 6. Audit Log

| ID | Source | Requirement | Type | Status |
|----|--------|-------------|------|--------|
| AUDIT-01 | FIXES_UI 8 / R2-10 | Layout: top-bar title; compact filter row; full-width table; newest first; sticky header; read-only (no per-row Restore or Delete). The single destructive control is the administrator-only "Clear audit log" (AUDIT-06), which requires typing DELETE. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| AUDIT-02 | FIXES_UI 8 | Toolbar `[Search activity…] [Action ▾] [Date range ▾] [Actor ▾]  N events`; hide Actor if no useful choices; search friendly labels/summaries/file names. | UI | IMPLEMENTED_AWAITING_CONFIRMATION |
| AUDIT-03 | FIXES_UI 8 | Table Time / Actor / Action / Record / Summary; Time DD/MM/YYYY HH:mm; Actor = Admin/Office account (email on hover, never imply individual for shared Office, fallback "Account unavailable", "System" only for system events); colored action badge; readable summary (no raw JSON). | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| AUDIT-04 | FIXES_UI 8 | Details side panel on event click: "field: old → new"; resolve from metadata; no invented names for deleted/renamed columns; optional sanitized "View raw"; empty states. | UI | IMPLEMENTED_AWAITING_CONFIRMATION
| AUDIT-05 | RESUME S3 | Real actor (join profiles), friendly action names, local timestamps, readable details + raw JSON on demand, filters for action/actor/date range. | Functional+UI | CONFIRMED_BY_USER |
| AUDIT-06 | R2-10 | Administrator-only "Clear audit log": type DELETE to confirm → remote audit_log cleared through the security-definer clear_audit_log() RPC (no DELETE policy exists for anyone), the local mirror is cleared, then exactly one entry "Audit log cleared by Admin on <date time>" is written. Office never sees the control and the RPC rejects an Office caller. SQL ships in ARENA/sql/fix-entries-rls.sql + supabase/schema.sql and must be run by the user. | Functional+UI | IMPLEMENTED_AWAITING_CONFIRMATION (SQL must be run by the user) |

## 7. Settings and dialogs

| ID | Source | Requirement | Type | Status |
|----|--------|-------------|------|--------|
| SET-01 | FIXES_UI 9.1 | Inner navigation layout (Expiry rules / Notifications / Workspace / About & updates); top bar visible; inputs max ~320px; responsive stacking; remove duplicate headings, Close, Export Data, Offline-first, permanent banner, backup UI, dev Resend text. | UI | IMPLEMENTED_AWAITING_CONFIRMATION
| SET-02 | FIXES_UI 9.2 | Expiry rules: two editable thresholds (urgent < expiring-soon), whole numbers; derived 5-band ranges; today = "Expires today" not "Expired"; editable color swatches + preview; "Reset to defaults" is draft-only. | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SET-03 | FIXES_UI 9.3 | Notifications: reminder chips (90/60/30/15/7/1/On expiry day + Add day), whole non-negative, no dupes, 0 = "On expiry day"; Daily + Weekly summary (enable/day/time); show actual saved state; weekly persists locally + Supabase; email status text; no email key field. | UI+Functional | CONFIRMED_BY_USER |
| SET-04 | FIXES_UI 9.4 / R2-08 | Workspace defaults: Currency/Symbol/Decimals (editable, no value conversion), Primary expiry (actual Date-Expiry columns only; canonical auto-select for one; preserve + Admin-change for many; recompute on change), Default theme for new sign-ins. R2-08: the default applies only when this PC has no saved personal preference; saving Settings and the theme toggle keep the personal choice. | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SET-05 | FIXES_UI 9.5 / R2-06 | About & updates: "DKS · Version [actual version]", "Made by Tacenta" and a GitHub icon that opens https://github.com/tacenta2k in the system browser through the main process (shell.openExternal, allowlisted host), plus Check for updates with its states (checking/no-update/available-downloading/ready-to-restart/failed); Office PCs still auto-update. | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SET-06 | FIXES_UI 9.6 | Settings saving via form draft: unsaved banner [Discard][Save]; save writes local first + queues cloud; prevent duplicate saves; error (not success) on local failure; "saved locally — waiting to sync" until acknowledged; leaving with unsaved offers Save/Discard/Cancel. | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SET-07 | FIXES_UI 10 | Column Setup dialog (opened by `+`): name + type (Text/Number/Phone/Email/Price/Date/Dropdown/Checkbox/Notes); Date → Start/Expiry; Dropdown options; Price defaults to currency; no passport checkbox; name required/trimmed; preserve on error; prevent duplicate submit; Enter submits when valid; Esc cancels. | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SET-08 | FIXES_UI 11 | Renewal dialog (primary expiry, future valid date, history+audit, no duplicate, no separate row); Snooze dialog (1d/3d/1wk/until date, no expiry change, invalid-date warning). | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SET-09 | FIXES_UI 11 | Print/PDF report dialog (Admin): range checkboxes + All-entries (mutually exclusive), dynamic user columns + Days Left, no draft/`+`/Actions/group/deleted, DKS header + generated time + range summary + ascending Days Left + page numbers + DD/MM/YYYY; [Cancel][Print][Export PDF]. | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SET-10 | FIXES_UI 11 | Import dialog (Admin): select file, preview first 20 rows, map to actual columns, confirm; preserve leading zeroes; DD/MM/YYYY parse; row-level problems; no premature cloud-success. | UI+Functional | CONFIRMED_BY_USER |
| SET-11 | FIXES_UI 12 / R2-14 | Confirmation dialogs: row delete / restore / permanent delete / column delete (with the count of records still holding a value) / Office-denied; destructive = red button; Cancel safe default; Esc and backdrop close; prevent duplicate submits; processing/failure state; server determines authorization. Implemented as the shared in-app `ConfirmDialog` (window.confirm is gone from the Recycle Bin and the sheet). | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SET-12 | FIXES_UI 13 | Login: keep working; remove obsolete developer placeholder text; no social/signup/passwordless/guest; no auth bypass; keep visual identity; no invented logo/fonts/palette. | UI | IMPLEMENTED_AWAITING_CONFIRMATION

## 8. Sync, persistence, and security

| ID | Source | Requirement | Type | Status |
|----|--------|-------------|------|--------|
| SYNC-01 | RESUME B5 | Persistence re-check: create row → full quit → reopen → persists locally + Supabase (rows, columns, settings). | Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SYNC-02 | RESUME S5 | Conflict handling: same row edited on two PCs → server wins, row flagged with tooltip, both versions in audit_log, no silent loss. | Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SYNC-03 | RESUME S6 | Notifications/tray: threshold alerts (default 90/60/30/15/7/1/0), no duplicate same-day alert, tray indication for expired/due≤7d, close-to-tray, autostart. | Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SYNC-04 | RESUME S7 | Changing primary expiry recomputes Days Left, colours, alerts immediately. | Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SYNC-05 | HANDOFF / task | Enforce Admin/Office with RLS + server functions AND service/IPC + renderer; hiding a button is not enough; no service-role creds in app. | Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SYNC-06 | RESUME S4 | End-to-end: Office deletes row → Admin notification → View + Restore work. | Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SYNC-07 | HANDOFF | Honest limitation: Office read access cannot distinguish view from export; Admin-only export is app policy (state this, don't overclaim). | Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SYNC-08 | task | Failed sync keeps local row + sanitized reason; successful sync removes exact outbox item; retries idempotent (no duplicates). | Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SYNC-09 | RESUME B6 / R2-13 | `npm run dev` should show/focus the Electron window (main-process logging, no hidden/tray-only startup). Fixed: only an explicit --hidden/--autostart/--startup flag may start hidden; the OS openAtLogin preference no longer hides the window, and autostart opens it normally. shouldStartHidden() is unit-tested. | Functional | IMPLEMENTED_AWAITING_CONFIRMATION |
| SYNC-10 | FIXES_UI 4/3.2 | Sync state + sidebar collapse state persist across restart. | UI+Functional | IMPLEMENTED_AWAITING_CONFIRMATION

## 9. Packaging and verification

| ID | Source | Requirement | Type | Status |
|----|--------|-------------|------|--------|
| PKG-01 | RESUME S8 | Add `author` to package.json (keep appId/productName). | Functional | CONFIRMED_BY_USER |
| PKG-02 | RESUME S9 | App icon: square PNG ≥256px → build/resources/icon.ico, referenced in electron-builder.yml. | Functional | BLOCKED (USER-ONLY — needs the user's PNG) |
| PKG-03 | RESUME 5 | NSIS installer build (winCodeSign symlink privilege) — user must run in an elevated terminal / Developer Mode. | Packaging | BLOCKED (USER-ONLY — elevated Windows terminal) |
| PKG-04 | HANDOFF / RESUME 11 | User-only: reset both Supabase passwords; run the approved SQL files; packaging in an elevated terminal; optional Resend secrets; provide the icon PNG; install/test on the office PCs. | User-only | BLOCKED (USER-ONLY) |
| PKG-05 | task / gate | Every phase: `npm rebuild better-sqlite3 && npm test && npm run typecheck && npm run build` green before commit. | Verification | IMPLEMENTED_AWAITING_CONFIRMATION |
| PKG-06 | HANDOFF | Re-test packaged exe: RLS, pending sync, installer, and user workflows; finalize README release steps (user performs releases). | Verification | NOT_STARTED (USER-ONLY — needs a Windows build and the real accounts) |
| PKG-07 | FIXES_UI 15 | Full UI verification checklist (Global / Visa Sheet / Dashboard / Recycle Bin / Audit Log / Settings / Safety). | Verification | NOT_STARTED (USER-ONLY — visual check on a real PC) |
| PKG-08 | RESUME F4 | No backup features remain (search backup/dks-backups/storage/Backup Now); keep absence-asserting tests/docs. | Functional | IMPLEMENTED_AWAITING_CONFIRMATION |

---

### Notes on scope
- UI batches to implement next (per `docs/FIXES_UI.md`): (1) Global shell & navigation (SHELL-*), (2) Visa Sheet structure (SHEET-01..16), (3) Dashboard/Recycle Bin/Audit Log layouts (DASH-*, RBIN-01/02, AUDIT-01/04), (4) Settings/dialogs/responsive + verification cleanup (SET-01/12, SYNC-10, PKG-07).
- Do NOT reintroduce anything in FIXES_UI Section 2. Do NOT invent pages/buttons/columns/features. No fake/seed data. No AG Grid Enterprise features.
