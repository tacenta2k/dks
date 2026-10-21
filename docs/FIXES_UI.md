# DKS — UI Redesign Requirements (LOCKED)

Status: Reviewed page-by-page and approved by the user (Aswin).
Scope: UI/UX only — layout, spacing, page structure, menus, popups, dialogs, table display, and visual presentation.

Read together with:
- `HANDOFF.md` — project overview, stack, roles, rules
- `docs/RESUME_NEXT_SESSION.md` — environment results and recorded bugs
- `docs/FIXES_NON_UI.md` — functional bugs and behavior fixes

Rules for the AI agent:
- Do NOT change business logic, RLS, authentication, database schema, or sync behavior because of this file, except where the UI must display existing state.
- Do NOT invent extra UI features, pages, buttons, or sections that are not described here.
- Do NOT bring back any element listed in Section 2.
- If something is unclear or not covered, keep the current behavior and ask the user instead of guessing.
- Implement in small steps. After each step run `npm test`, `npm run typecheck`, `npm run build`, then commit.

---

## 1. Global UI Principles

DKS is a Windows desktop app for a visa/medical office. It must feel like a fast, compact, Excel-like desktop tool — NOT a website or landing page.

- Use screen space efficiently. No narrow centered containers.
- On the Visa Sheet, the grid is the main thing.
- Remove unnecessary headings, subtitles, eyebrow labels, cards, and decorative chips.
- No duplicate controls (every control exists in exactly one place).
- Same compact top bar and sidebar on every page.
- Use floating popups/dropdowns, never expanding text inside the top bar.
- Admin-only controls are fully hidden (not disabled/greyed) for Office users.
- Show human-readable values only: no UUIDs, no ISO timestamps, no raw JSON in visible UI.
- All visible dates use `DD/MM/YYYY`. Date-times use `DD/MM/YYYY HH:mm` in local (Oman) time.

---

## 2. Removed Elements — NEVER Reintroduce

- Breadcrumbs like `DKS / Workspace`, `DKS / Overview`, `DKS / Administration`
- Subtitle `A focused space for your team's records`
- Eyebrow labels: `WORKSPACE`, `OVERVIEW`, `ADMINISTRATION`, `EXPIRY RULES`, `Admin tools`
- Developer text like `Your visa records will appear here in STEP 4.` and `STEP 2 · Role-gated workspace`
- Visible email text in the top bar
- Standalone `Log out` button in the top bar
- `Theme: Light ▾` / `Theme: Dark ▾` text control
- Inline notification text in the top bar (`Notifications 0 unread / No notifications`)
- `Offline-first` decorative pill
- `Workspace health` box in the sidebar footer (replaced by the real sync status in the top bar)
- `Export data` button on Dashboard or Settings
- `ADMINISTRATOR TOOLS / Manage records` card with Export CSV / Export Excel / Import file / Print buttons
- `Add row` button
- `Add column` button
- `Manage columns` button and panel
- `Group by Category` button
- `Actions` column in the grid (Duplicate / Delete / Renew buttons)
- `Load Visa Template` button
- Category filter dropdown and `Uncategorized · N` chip
- Hide column feature (no Hide option anywhere, no "Hidden (N)" chip)
- `Passport number column` checkbox and any passport-format validation UI
- `Close settings` button
- Permanent banner `Settings saved to the workspace.`
- Any backup UI (`Backup Now`, backup section, backup info)
- Raw row IDs like `row-7ce65046-...` as visible labels
- Raw ISO timestamps like `2026-10-21T03:50:44.587Z`
- Raw JSON like `{"before":null,"after":{...}}` in visible table cells

---

## 3. Global App Shell

### 3.1 Top Bar (every page)

Height: about 48–52px. Compact spacing.

```
[☰] Page Title                          [● Saved to cloud] [🔔] [☾] [S]
```

Left:
- `☰` sidebar collapse/expand button
- Plain page title: `Dashboard`, `Visa Sheet`, `Settings`, `Recycle Bin`, `Audit Log`

Right:
- Real sync status
- Notification bell (icon only)
- Theme toggle (icon only)
- Profile avatar

The top bar must NOT contain: breadcrumbs, subtitles, email text, logout button, search, filters, import/export, or any page-specific control. It must render on every page (it currently renders blank on Settings — fix that).

### 3.2 Sync Status (global)

Shown on every page because sync runs in the background.

```
● Saved to cloud
◐ Syncing…
○ Offline — saved locally
⚠ Sync error
```

- Must reflect the real sync state, never decorative.
- Hover or click shows a small popup: pending change count, last successful sync time, error details if any.
- It replaces the old `Offline-first` pill and the sidebar `Workspace health` box.

### 3.3 Notification Bell

- Compact bell icon with a small unread badge (number) when unread > 0.
- Click opens a floating popover anchored below the bell. Click outside or press Esc to close.
- Never render notification text inside the top bar.

Empty:
```
Notifications
No notifications
```

With items:
```
Notifications                         2 unread
──────────────────────────────────────────────
🔴 Ahmed Ali expires in 7 days
   [Snooze] [Dismiss]
──────────────────────────────────────────────
🗑 Office deleted Priya Nair · 21/10/2026 09:12
   [View] [Restore] [Dismiss]
```

Role rules:
- Office: expiry alerts only.
- Admin: expiry alerts + deletion alerts (View / Restore / Dismiss).

### 3.4 Theme Toggle

- Icon button only: ☀ in dark mode, ☾ in light mode.
- One click toggles light/dark directly.
- Tooltip: `Switch to dark mode` / `Switch to light mode`.
- This is a personal, per-PC preference.

### 3.5 Profile Avatar Menu

Top bar shows only the avatar circle with the initial (e.g. `S`).

Click opens popover:
```
shahabasnavas123@gmail.com
[Admin]
──────────────────────────
Log out
```

- Role badge shows `Admin` or `Office`.
- Logout exists only here (and in the tray menu).

---

## 4. Sidebar

### 4.1 Expanded (about 220px)

```
[D] DKS
    Office workspace   (or "Admin workspace")

Dashboard
Visa Sheet
Settings        (Admin only)
Recycle Bin     (Admin only)
Audit Log       (Admin only)
```

### 4.2 Collapsed (about 56px)

```
[D]
[Dashboard icon]
[Sheet icon]
[Settings icon]
[Recycle icon]
[Audit icon]
```

Rules:
- Collapsed shows logo and icons only, no text.
- Tooltip with the page name on hover when collapsed.
- Toggled by the `☰` button in the top bar.
- State (collapsed/expanded) is remembered after restart.
- Office users never see Settings, Recycle Bin, or Audit Log.
- Each item gets a distinct, meaningful icon (not the same generic grid icon for all).
- No footer box at the bottom of the sidebar.

---

## 5. Visa Sheet Page (most important)

### 5.1 Layout

No page header, no cards, no centered container.

```
Global top bar
Sheet toolbar (one slim row)
Grid fills ALL remaining width and height
```

The grid stretches edge-to-edge (from the sidebar to the right edge, down to the bottom of the window).

### 5.2 Sheet Toolbar

Height: about 44–48px. Only on the Visa Sheet page.

```
[🔍 Search records…] [Status: All ▾] [Today] [≤7d] [≤30d] [≤60d] [≤90d] [No expiry] [Group by ▾]      [Tools ▾]
```

- Search: always visible, filters across all visible text.
- Status dropdown: `All statuses`, `Valid`, `Expiring Soon`, `Urgent`, `Expired`.
- Date chips (`Today`, `≤7d`, `≤30d`, `≤60d`, `≤90d`, `No expiry`): single-select. Clicking the active chip again clears it. There is NO separate `Expired` chip (Expired lives in the Status dropdown).
- `Group by ▾`: small dropdown listing only user-created Text or Dropdown columns, plus `None`. Hidden completely if no suitable column exists.
- `Tools ▾`: Admin only, right-aligned, fully hidden for Office.

Small windows:
- Search box shrinks first.
- Less-used chips move into a `More filters ▾` dropdown.
- Toolbar must never wrap into multiple rows and must never overflow horizontally.

### 5.3 Tools Menu (Admin only)

```
Tools ▾
├─ Import file
├─ Export CSV
├─ Export Excel
└─ Print / PDF report
```

- `Print / PDF report` opens the range/column selection dialog (Section 11). It never prints immediately.
- Hidden in UI for Office AND checked by role in the service/Electron handler (hiding alone is not enough).

### 5.4 Grid Structure

```
┌───┬──────────────┬─────────────┬─────────────┬─────┬────────────┐
│ # │ Name         │ Passport No │ Visa Expiry★│  +  │ Days Left  │
├───┼──────────────┼─────────────┼─────────────┼─────┼────────────┤
│ 1 │ Ahmed Ali    │ IND12345    │ 15/12/2026  │     │ 65 days    │
│ 2 │ Priya Nair   │ PAK88888    │ 02/03/2025  │     │ Expired    │
│ 3 │              │             │             │     │ —          │ ← blank draft row
└───┴──────────────┴─────────────┴─────────────┴─────┴────────────┘
```

Required behavior:
- Row-number gutter (`1, 2, 3…`) pinned on the left. It is also the right-click target for row menus.
- Header row sticky when scrolling down.
- Row gutter and first data column stay visible when scrolling right.
- Click header = sort (small ↑/↓ indicator).
- Drag header = reorder user columns (position saved).
- Drag column border = resize. Double-click border = auto-fit to content.
- `Days Left` always the last column, pinned right, locked.
- The primary expiry column shows a small `★` next to its name.
- Compact rows: about 30–34px tall, 13–14px font.
- Long text truncates with `…`; full value shown on hover.
- Clean, subtle 1px Excel-like grid lines.
- Click a cell to edit directly. Enter moves down, Tab moves right. Ctrl+C / Ctrl+V work.
- Whole-row tint by status (colors from Settings); the Days Left cell uses a stronger version of the same color.

### 5.5 Date Cells

- Every Date-type column (start or expiry) displays `DD/MM/YYYY`.
- Typing auto-inserts slashes: `10` → `10/`, `1001` → `10/01/`, `10012004` → `10/01/2004`.
- Pasting `10012004` becomes `10/01/2004`.
- A small calendar button / date picker remains available.
- Invalid dates (e.g. `31/02/2026`) show a red border with a tooltip; saving is not blocked.
- Applies only to Date-type columns, not to Text columns that happen to be named "Date".

### 5.6 `+` Column Header

```
…user columns… │ + │ Days Left
```

- Narrow header-only control (about 44–48px), pinned right, immediately before Days Left. Never scrolls out of view.
- Body cells under it are blank and non-editable.
- No sort, no filter, no right-click menu.
- Excluded from CSV, Excel, PDF, and print.
- Clicking it opens Column Setup (Section 10).
- With zero user columns, the grid shows only `#`, `+`, and `Days Left`.

### 5.7 Blank Draft Row

- Always pinned at the bottom of the grid and always visible, even with hundreds of rows.
- Typing the first real value into any cell creates and saves a new entry.
- That row then becomes a normal numbered row and a fresh blank row appears below.
- Clicking the draft row without typing must NOT create an empty database entry.
- The draft row is excluded from dashboard counts, export, print, notifications, sorting, and filtering.

### 5.8 Right-Click Menus

Column header (normal user column):
```
Rename
Duplicate column
Delete column
```
Admin right-clicking a Date (Expiry) column also sees:
```
★ Set as Primary Expiry
```

Rules:
- `Days Left` and `+` have no rename/delete menu.
- No Hide option.
- Delete always asks confirmation (Section 12).
- Office can delete only empty columns. Admin can delete a column with data after a strong warning.
- Duplicate column copies only the name, type, and options — NOT the row values. Default name: `Original Name (copy)`.

Row (right-click the row number or any cell):
```
Mark as Renewed
Duplicate row
Delete row
Snooze alert
```

- Mark as Renewed opens the Renew dialog (Section 11).
- Delete row asks confirmation, then moves to Recycle Bin.
- These replace the removed Actions column.

### 5.9 Empty States (only one at a time)

- Zero columns: `Click + to add your first column`
- Columns but zero saved rows: `Type in the blank row to add your first entry`
- Filters return nothing: `No records match these filters`

Never show two messages together (e.g. `No Rows To Show` + `No records match the current filters`). The message must never cover the blank draft row.

---

## 6. Dashboard Page

### 6.1 Remove

- `OVERVIEW` label, big duplicate `Dashboard` heading, `Your workspace is ready for the next step.`
- `Offline-first` pill
- `Export data` button

The top bar already shows `[☰] Dashboard`.

### 6.2 Stat Cards

Full width, compact cards (about 80px tall). Dashboard should fit on one screen without scrolling at normal desktop size.

Row 1 — immediate attention (5 cards):
1. Total Entries (neutral)
2. Expired (dark red accent)
3. Expiring Today (red accent)
4. This Week (orange accent)
5. This Month (yellow accent)

Row 2 — upcoming (4 cards):
6. Within 2 Months
7. Within 3 Months
8. Within 6 Months
9. Within 1 Year

- Clicking a card opens the Visa Sheet filtered to that range.

### 6.3 Charts

Side by side below the cards, filling the remaining height:
- Left (~40%): Expiry Status donut chart with legend + counts (Valid, Expiring Soon, Urgent, Expires today, Expired).
- Right (~60%): Next 12 Months bar chart.
- With no data, show a centered message inside each chart: `No expiry data yet` (no blank empty axes).

---

## 7. Recycle Bin Page (Admin only)

### 7.1 Layout

Top bar: `[☰] Recycle Bin`. No breadcrumb, subtitle, `Admin tools`, big title, or record count block.

### 7.2 Toolbar

```
[🔍 Search deleted records…]                  3 items · auto-deleted after 30 days
```

### 7.3 Table (full width)

```
Name          | Passport No | Expiry     | Deleted           | Purge in | 
Aarav Kumar   | Z1234567    | 31/12/2026 | 21/10/2026 03:50  | 29 days  | [Restore] [Delete]
```

- Name = friendly label (Name column, else first text column). Never a raw row ID.
- No duplicate `Record` + `Name` columns.
- Phone column dropped.
- Expiry `DD/MM/YYYY`; Deleted `DD/MM/YYYY HH:mm` local time.
- Purge in = days left before automatic permanent deletion.
- Buttons short and equal: `[Restore]` `[Delete]` — never `Permanently delete Aarav Kumar`. Buttons never wrap to two lines.
- Newest deleted first. Sticky header.
- Empty state: `Recycle bin is empty`

Confirmations:
- Restore: `Restore "Aarav Kumar" to the sheet?` [Cancel] [Restore]
- Delete: `Permanently delete "Aarav Kumar"? This cannot be undone.` [Cancel] [Permanently delete]

(Note: permanent delete currently crashes with an IPC `ensureOpen` error — that is a non-UI bug tracked in `RESUME_NEXT_SESSION.md`.)

---

## 8. Audit Log Page (Admin only, read-only)

### 8.1 Layout

Top bar: `[☰] Audit Log`. No breadcrumb, subtitle, `Admin tools`, or big title block.

### 8.2 Toolbar

```
[🔍 Search activity…] [Action: All ▾] [Date range ▾] [Actor ▾]        124 events
```

- Action filter: All, Created, Edited, Soft-deleted, Restored, Permanently deleted, Renewed, Imported, Exported, Column added, Column deleted.
- Date range: All time, Today, Last 7 days, Last 30 days.
- Actor filter hidden if only one actor exists.

### 8.3 Table (full width)

```
Time              | Actor  | Action   | Record      | Summary
21/10/2026 07:45  | Admin  | Imported | —           | Imported 3 records from dks-test-import.csv
21/10/2026 07:50  | Office | Deleted  | Ahmed Ali   | Moved to Recycle Bin
```

- Time: `DD/MM/YYYY HH:mm` local time.
- Actor: `Admin` or `Office` (with email on hover). Never `Unknown`. Office is a shared account — do not imply a specific staff member.
- Action: readable word, small colored badge.
- Record: friendly record name, `—` if not row-related. Never UUIDs.
- Summary: one human-readable sentence. Never raw JSON.
- Newest first, sticky header.
- Clicking a row opens a side details panel: `Field: old value → new value`. A small `View raw` link inside the panel may show formatted JSON for debugging only.
- No Restore/Delete buttons here (those belong to Recycle Bin).
- Empty state: `No audit events yet`

---

## 9. Settings Page (Admin only)

### 9.1 Layout

Top bar: `[☰] Settings`. Remove duplicate headings, `ADMINISTRATION`, `Close settings`, `Export data`, `Offline-first`, permanent success banner, and developer Resend text.

Inner navigation on the left, content on the right (no long scrolling page):

```
┌──────────────────┬───────────────────────────────────────┐
│ Expiry rules     │  (selected section content)           │
│ Notifications    │                                       │
│ Workspace        │                                       │
│ About & updates  │                                       │
└──────────────────┴───────────────────────────────────────┘
```

Inputs have a sensible max width (about 320px) and never stretch across the screen.

### 9.2 Expiry Rules

Only two editable numbers; ranges calculate automatically so gaps/overlaps are impossible:

```
Urgent threshold:         [ 30 ] days
Expiring soon threshold:  [ 90 ] days
```

Resulting rules shown clearly with color swatches:

```
Valid          More than 90 days     [green]
Expiring soon  30–90 days            [yellow]
Urgent         1–29 days             [orange]
Expires today  0 days                [red]
Expired        Date has passed       [dark red / gray]
```

- Today shows `Expires today`, not `Expired`.
- Click a swatch to change its color.
- Validation: urgent threshold must be lower than expiring-soon threshold.
- Small live preview of example rows in each status.
- `Reset to defaults` link.

### 9.3 Notifications

Reminder days as chips (not tall input rows):

```
Remind me:  [90 ×] [60 ×] [30 ×] [15 ×] [7 ×] [1 ×] [On expiry day ×]  [+ Add day]
```

- `0` displays as `On expiry day`.
- `×` removes a chip; `+ Add day` shows a tiny inline number input.

Summaries:
```
[✓] Daily summary    at [09:00]
[✓] Weekly summary   every [Monday ▾] at [09:00]
```

Email status line (plain language):
- Configured: `Email notifications active`
- Not configured: `Email notifications not configured. Windows notifications still work.`

### 9.4 Workspace

```
Currency:        [OMR ▾]     Symbol: [ر.ع.]    Decimals: [3]
Primary expiry:  [★ Visa Expiry ▾]
Default theme for new sign-ins: [Light ▾]
```

- Choosing a currency auto-fills symbol and decimals (OMR → ر.ع., 3; INR → ₹, 2), still editable.
- Primary expiry lists all Date (Expiry) columns. If one exists, it must be selected — never show `No primary expiry column` when an expiry column exists.
- Default theme only sets the starting theme on a new PC; it never overrides a user's own toggle.

### 9.5 About & Updates

```
DKS  ·  Version 0.1.0                 [Check for updates]
Last checked: 21/10/2026 09:10
```

- Automatic background updates must still work for Office PCs even though Office cannot open Settings.

### 9.6 Saving

- A slim bar appears at the bottom only when something changed:
  `You have unsaved changes.        [Discard] [Save settings]`
- On save: short toast `Settings saved.` and the top-bar sync status shows the real result (Saved to cloud / Saved locally — waiting to sync / Sync error).
- Never show a success message that contradicts a sync error.

---

## 10. Column Setup Dialog

Opened by clicking the `+` header. Compact modal.

```
Add column

Column name:  [ e.g. Passport number ]
Column type:  [ Text ▾ ]

            [Cancel]  [Add column]
```

Types: Text, Number, Phone, Email, Price / Amount, Date, Dropdown, Checkbox, Notes.

- Date → second choice appears: `Start date` / `Expiry date`. Only Expiry drives Days Left and colors.
- Adding a second Expiry column asks: `Set as primary expiry?`
- Dropdown → options input (comma-separated or one per line).
- Price → uses currency from Settings.
- No passport checkbox, no country validation.
- Enter submits, Esc cancels.

---

## 11. Other Dialogs

### Renew (row right-click → Mark as Renewed)
```
Mark as renewed — Ahmed Ali

Current expiry:  15/12/2026
New expiry:      [DD/MM/YYYY] [📅]

            [Cancel]  [Renew]
```
- New date must be in the future.

### Snooze (row right-click → Snooze alert)
```
Snooze alerts for Ahmed Ali
( ) 1 day   ( ) 3 days   ( ) 1 week   ( ) Until [DD/MM/YYYY]
            [Cancel]  [Snooze]
```

### Print / PDF report (Tools → Print / PDF report)
```
Print / PDF report

Records:  [ ] Expiring today  [ ] This week   [ ] This month
          [ ] In 2 months     [ ] In 3 months [ ] In 6 months
          [ ] In 1 year       [ ] Expired     [ ] All

Columns:  [✓] Name  [✓] Passport No  [✓] Visa Expiry  [✓] Days Left  [ ] Status …

            [Cancel]  [Print]  [Export PDF]
```
Report output: DKS header, generated date/time, filter summary, clean table sorted by Days Left, page numbers, dates in `DD/MM/YYYY`. Never includes the `+` column or the draft row.

### Import (Tools → Import file)
- File picker → preview first 20 rows → map file columns to existing columns → Import.
- Dates in the file shown as `DD/MM/YYYY` in the preview.

---

## 12. Confirmation Dialogs

Short, clear, consistent:

- Row delete: `Move "Ahmed Ali" to the Recycle Bin?` [Cancel] [Delete]
- Permanent delete: `Permanently delete "Ahmed Ali"? This cannot be undone.` [Cancel] [Permanently delete]
- Empty column delete: `Delete column "Phone"?` [Cancel] [Delete column]
- Admin deleting a column with data: `"Phone" contains data in 24 rows. Deleting it removes these values permanently.` [Cancel] [Delete column]
- Office trying to delete a column with data: `Only an admin can delete a column that contains data.` [OK]

Destructive buttons are red. Esc / Cancel always closes safely.

---

## 13. Pages Not Yet Reviewed in Detail

The **Login screen** and the **final color palette / typography system** have not been reviewed page-by-page yet. Until they are:
- Keep the current Login screen working; only remove developer text (`STEP 2…`, placeholder text) and keep it consistent with the new compact style.
- Use one consistent font, border radius, and spacing scale across all pages.
- Do not invent a new brand style. Ask the user before major visual changes.

---

## 14. Visual Tone

Use:
- Compact desktop spacing (8px-based scale)
- Subtle borders and clean 1px grid lines
- High-contrast text, muted backgrounds
- Consistent border radius on all buttons, inputs, popovers, and dialogs
- Both light and dark themes fully supported on every page, popup, chart, and grid

Avoid:
- Landing-page hero sections and giant headings
- Big cards wrapped around tables
- Large empty margins
- Decorative chips that don't reflect real state
- Technical strings in user-facing UI

---

## 15. Interaction & Accessibility

- Icon-only buttons have tooltips.
- Popovers and dropdowns close on outside click and Esc.
- Dialogs: Enter confirms, Esc cancels, focus goes to the first input.
- Grid keyboard: arrows move, Enter edits/moves down, Tab moves right, Esc cancels edit, Ctrl+C/V copy-paste, Ctrl+Z/Y undo/redo if implemented.

---

## 16. Verification Checklist

Global:
- [ ] Top bar 48–52px, shows title / sync / bell / theme icon / avatar on every page (including Settings)
- [ ] No breadcrumb, subtitle, email text, or logout button in top bar
- [ ] Sidebar collapses to icons, expands with text, remembers state
- [ ] Office sees only Dashboard and Visa Sheet in sidebar
- [ ] Sync pill shows real state with details on hover/click
- [ ] Bell opens a floating popover
- [ ] Theme icon toggles directly
- [ ] Avatar popover shows email, role, Log out

Visa Sheet:
- [ ] No Add row / Add column / Manage columns / Group by Category / Actions column / Load template
- [ ] One-row toolbar; Tools menu Admin-only
- [ ] Grid full width and height
- [ ] Row numbers on left, `+` and Days Left pinned right
- [ ] Blank draft row creates entries only when typing
- [ ] Right-click column and row menus work, no Hide option
- [ ] `★ Set as Primary Expiry` for Admin on expiry columns
- [ ] Dates DD/MM/YYYY with auto-slash
- [ ] One empty-state message at a time

Dashboard:
- [ ] No inner header, no Export data
- [ ] 5 + 4 card layout, urgent first, cards clickable
- [ ] Charts side by side, clean empty state

Recycle Bin:
- [ ] Friendly names, no UUIDs, no ISO times
- [ ] Short Restore/Delete buttons with confirmations
- [ ] Purge-in column, search, empty state

Audit Log:
- [ ] Readable time/actor/action/record/summary
- [ ] No raw JSON in table; details panel works
- [ ] Filters work; read-only

Settings:
- [ ] Inner navigation with 4 sections, no long scroll
- [ ] Two-number thresholds with live preview, "Expires today" wording
- [ ] Notification chips, daily + weekly summary
- [ ] Primary expiry correctly selected
- [ ] Unsaved-changes bar; truthful save status
- [ ] No Export data / Close settings / Offline-first / backup UI

End of UI redesign requirements.