# DKS — UI Redesign Requirements (LOCKED)

Status: Reviewed page-by-page and approved by the user.
Scope: UI/UX only — layout, spacing, page structure, menus, popups, dialogs,
table display, and visual presentation.

Read together with:

1. `HANDOFF.md` — project overview, security, roles, stack, hard rules
2. `docs/RESUME_NEXT_SESSION.md` — non-UI bugs, functional decisions,
   verification tasks, build notes

There is NO `docs/FIXES_NON_UI.md` file.

## Implementation order

1. First complete the functional/non-UI work in
   `docs/RESUME_NEXT_SESSION.md`.
2. Ensure tests, typecheck, and build pass.
3. Then implement this UI redesign in small, tested commits.
4. Do not reintroduce anything listed in Section 2.

Rules for the AI agent:

- Do NOT weaken authentication, RLS, roles, sync, or database rules to make
  the UI easier to implement.
- Do NOT invent extra pages, buttons, controls, business columns, or features.
- Do NOT create fake data, seed example people, or delete existing user data.
- Do NOT use paid AG Grid Enterprise-only features or add paid libraries.
- Use AG Grid Community-compatible/custom components where needed.
- After each working UI step run:
  ```bash
  npm test
  npm run typecheck
  npm run build
  ```
  Then commit the verified work.
- If a requirement conflicts with `HANDOFF.md` or
  `docs/RESUME_NEXT_SESSION.md`, stop and ask the user rather than guessing.

---

# 1. Global UI Principles

DKS must feel like a compact Windows desktop office application with an
Excel-like workspace — not a marketing website or landing page.

Main goals:

- Use screen space efficiently.
- Avoid narrow centered containers.
- Avoid large empty areas.
- On Visa Sheet, the grid is the main focus.
- Use one compact global top bar on every page.
- Use popovers/dropdowns instead of expanding text inside the top bar.
- Avoid duplicate controls.
- Hide admin-only features completely for Office users.
- Display readable text only: no UUIDs, raw JSON, raw ISO timestamps, or
  developer labels in normal UI.
- Visible dates: `DD/MM/YYYY`.
- Visible date/time: `DD/MM/YYYY HH:mm` in Oman time (`Asia/Muscat`).
- Support light and dark themes consistently.

---

# 2. Removed Elements — NEVER Reintroduce

## Global shell

- Breadcrumbs such as `DKS / Workspace`, `DKS / Overview`,
  `DKS / Administration`
- Subtitle `A focused space for your team's records`
- Eyebrow labels such as `WORKSPACE`, `OVERVIEW`, `ADMINISTRATION`,
  `EXPIRY RULES`, `Admin tools`
- Developer text such as:
  - `Your visa records will appear here in STEP 4.`
  - `STEP 2 · Role-gated workspace`
  - `Your workspace is ready for the next step.`
- Visible email text in the top bar
- Standalone Log out button in the top bar
- `Theme: Light ▾` / `Theme: Dark ▾` text control
- Inline notification content in the top bar
- Decorative `Offline-first` pill
- Sidebar `Workspace health` footer box
- Export Data button on Dashboard or Settings

## Visa Sheet

- Add Row toolbar button
- Add Column toolbar button
- Manage Columns button/panel
- Group by Category button
- Actions grid column containing Duplicate/Delete/Renew buttons
- Load Visa Template button
- Built-in Category filter
- `Uncategorized · N` chip
- Hide column / unhide column features
- Passport number column checkbox
- Country-specific passport validation UI
- Large Administrator Tools / Manage Records card
- Separate Export buttons outside the Tools menu

## Settings

- Duplicate Settings headings
- Close settings button
- Permanent `Settings saved to the workspace` banner
- Developer-facing Resend technical text
- Backup controls or Backup Now UI

## User-facing data

- Raw UUID labels such as `row-7ce65046-...`
- Raw ISO dates such as `2026-10-21T03:50:44.587Z`
- Raw JSON inside normal tables

---

# 3. Global App Shell

## 3.1 Compact top bar

Height: approximately 48–52px.

```text
[☰] Page Title                          [Sync status] [Bell] [Theme] [Avatar]
```

### Left side

- Sidebar expand/collapse button
- Current page title only:
  - Dashboard
  - Visa Sheet
  - Settings
  - Recycle Bin
  - Audit Log

### Right side

- Real sync status
- Notification bell icon
- Theme icon button
- Profile avatar

Do NOT place Search, filters, Import, Export, Print, breadcrumbs, email, or
Logout in the global top bar.

The top bar must render consistently on every authenticated page, including
Settings.

---

## 3.2 Global sync status

Sync happens in the background on every page, so status belongs in the global
top bar.

Possible states:

```text
● Saved to cloud
◐ Syncing…
○ Offline — saved locally
⚠ Sync error
```

Rules:

- Must use actual outbox/sync state, never a decorative static label.
- `Saved to cloud` only appears after confirmed remote acknowledgement.
- `Offline — saved locally` only appears after successful local SQLite save.
- `Sync error` must not use a green success icon.
- Pending count can appear, for example:
  ```text
  Syncing… · 3 pending
  ```
- Click or keyboard activation opens a compact popover with:
  - pending change count
  - last successful sync time
  - safe/sanitized error message if sync failed

The real pending sync bug is tracked in `docs/RESUME_NEXT_SESSION.md`. Do not
hide or clear pending operations merely to make the UI look successful.

---

## 3.3 Notification bell

- Use a compact bell icon button.
- Show unread badge only when unread count is above zero.
- Clicking opens a floating popover below/near the bell.
- Clicking outside or pressing Escape closes it.
- Never insert notification text into the top bar itself.

Empty state:

```text
Notifications

No notifications
```

Example alerts:

```text
Ahmed Ali expires in 7 days
[Snooze] [Dismiss]

Office account deleted Priya Nair
21/10/2026 09:12
[View] [Restore] [Dismiss]
```

Role behavior:

- Office: expiry/reminder alerts only.
- Admin: expiry/reminder alerts plus Office deletion alerts.
- Office must never see Admin-only deletion details.
- Restore appears only when the deleted row is still restorable.

---

## 3.4 Theme toggle

- Icon-only toggle.
- Light mode shows moon icon with tooltip:
  `Switch to dark mode`
- Dark mode shows sun icon with tooltip:
  `Switch to light mode`
- One click switches between light and dark.
- Theme preference is personal/per-PC.
- All grids, charts, dialogs, popovers, and pages must follow the theme.

---

## 3.5 Profile avatar popup

Only the avatar remains visible in the top bar.

Clicking it opens:

```text
shahabasnavas123@gmail.com
[Admin]

────────────────────────
Log out
```

Rules:

- Show actual logged-in email and actual role.
- Logout exists here and in tray menu only.
- Click outside or Esc closes the popup.
- Do not discard pending local changes during logout.

---

# 4. Collapsible Sidebar

## Expanded mode

Width: approximately 220px.

```text
[D] DKS
    Admin workspace / Office workspace

[Dashboard icon] Dashboard
[Sheet icon]     Visa Sheet
[Settings icon]  Settings        (Admin only)
[Recycle icon]   Recycle Bin     (Admin only)
[Audit icon]     Audit Log       (Admin only)
```

## Collapsed mode

Width: approximately 56px.

```text
[D]
[Dashboard icon]
[Sheet icon]
[Settings icon]
[Recycle icon]
[Audit icon]
```

Rules:

- Collapsed mode shows logo and icons only.
- Hover/focus tooltip identifies each icon.
- Sidebar toggle is the `☰` button in global top bar.
- Expanded/collapsed state persists after app restart.
- Collapsing must give more width to the current page.
- Use distinct icons for each page.
- Current page has clear selected state.
- Office sees only Dashboard and Visa Sheet.
- No bottom Workspace Health / STEP footer box.

---

# 5. Visa Sheet Page

This is the main DKS workspace.

## 5.1 Layout

```text
Global top bar
One compact Sheet toolbar
Grid fills remaining width and height
```

Rules:

- No big Visa Sheet title.
- No page subtitle.
- No outer centered card.
- No large empty margins.
- Grid uses nearly all remaining space.
- Grid handles row scrolling internally.
- Horizontal grid scroll is allowed when many columns exist.

---

## 5.2 Sheet toolbar

Height: approximately 44–48px.

```text
[Search records…] [Status ▾] [Today] [≤7d] [≤30d] [≤60d] [≤90d] [No expiry] [Group by ▾]      [Tools ▾]
```

At normal desktop width, keep it as one row.

### Search

- Exists only here, not in global top bar.
- Searches across visible user data.
- Does not prioritize raw IDs as customer labels.

### Status dropdown

Options:

```text
All statuses
Valid
Expiring Soon
Urgent
Expired
```

### Quick date filters

```text
Today
≤7d
≤30d
≤60d
≤90d
No expiry
```

Rules:

- Single-select chips.
- Clicking active chip clears it.
- `Today` means Days Left = 0.
- `≤7d` means Days Left 0–7.
- `≤30d` means Days Left 0–30.
- `≤60d` means Days Left 0–60.
- `≤90d` means Days Left 0–90.
- No expiry means blank/missing Primary Expiry.
- Past/expired dates are NOT included in upcoming-date chips.
- Expired is selected from Status dropdown; no separate Expired chip.
- Search, Status, and date filters combine logically.

### Group by

- Lists only existing user-created Text or Dropdown columns.
- Includes `None`.
- Hidden completely when no appropriate column exists.
- No Category-specific behavior.
- Group headers appear inside the grid.
- Group headers are not export rows, report rows, or normal data rows.
- Use a Community-compatible/custom implementation if native AG Grid grouping
  requires Enterprise.

### Tools

Admin-only, right aligned:

```text
Tools
├─ Import file
├─ Export CSV
├─ Export Excel
└─ Print / PDF report
```

Rules:

- Fully absent for Office users.
- Print/PDF opens report selection dialog; never prints immediately.
- Tools must use real corrected import/export/print services.
- Role must also be checked by service/IPC, not just by hidden UI.

### Smaller windows

- Search shrinks first.
- Less-used quick filters may move into `More filters ▾`.
- Keep toolbar compact.
- Do not wrap into several tall rows.
- Do not overflow entire window horizontally.

---

## 5.3 Grid structure

Example only:

```text
┌───┬──────────────┬─────────────┬─────────────┬─────┬────────────┐
│ # │ Name         │ Passport No │ Visa Expiry★│  +  │ Days Left  │
├───┼──────────────┼─────────────┼─────────────┼─────┼────────────┤
│ 1 │ Ahmed Ali    │ TEST12345   │ 15/12/2026  │     │ 65 days    │
│ 2 │ Priya Nair   │ SAMPLE88    │ 02/03/2025  │     │ Expired    │
├───┼──────────────┼─────────────┼─────────────┼─────┼────────────┤
│   │              │             │             │     │ —          │
└───┴──────────────┴─────────────┴─────────────┴─────┴────────────┘
```

Requirements:

- Row-number gutter pinned left.
- Header stays visible while scrolling down.
- First user data column stays visible while scrolling right when feasible.
- Click header to sort; show small sort direction indicator.
- Drag user column header to reorder.
- Drag border to resize.
- Double-click border auto-fits column content.
- Do not use AG Grid Enterprise-only APIs.
- Days Left:
  - always final column
  - pinned right
  - locked
  - never editable/deletable/reorderable
- Primary expiry column shows small `★`.
- Compact row height: approximately 30–34px.
- Readable 13–14px text.
- Subtle 1px grid lines.
- Long values truncate with `…`; full value appears on hover/focus/editor.
- Whole row is lightly tinted from expiry status.
- Days Left cell uses stronger status color.
- Text remains readable on tinted/selected rows.

---

## 5.4 Date cells

Functional date handling is defined in `docs/RESUME_NEXT_SESSION.md`.
This section defines visible behavior.

- All Date-type columns display `DD/MM/YYYY`.
- Typing `10012004` becomes `10/01/2004`.
- Typing inserts slashes progressively.
- Pasting date digits/text normalizes when possible.
- Calendar/date picker remains available.
- Invalid dates show warning border/tooltip.
- Invalid dates must not silently become another date.
- Applies only to real Date-type columns, not Text columns with date-like names.
- Date-only display must not move a date because of timezone conversion.

---

## 5.5 `+` column header

Structure:

```text
…user columns… │ + │ Days Left
```

Rules:

- Width approximately 44–48px.
- Pinned immediately before Days Left.
- Header has accessible label `Add column`.
- Clicking opens Column Setup dialog.
- No sort/filter/drag/right-click menu.
- Body cells under it remain blank/non-editable.
- Excluded from CSV, Excel, Print, and PDF.
- With zero user columns, show only row gutter, `+`, and Days Left.
- No A/B/C spreadsheet-letter row.

---

## 5.6 Draft row

There is always one blank row pinned at the bottom.

Rules:

- It remains visible while scrolling, sorting, grouping, and filtering.
- It has no record number until it becomes real.
- Focusing/clicking alone does not create a row.
- First meaningful committed value creates exactly one row.
- Numeric zero and explicit false/checkbox values are meaningful values.
- Do not create a new row per keystroke.
- After save, that row becomes normal and a fresh blank draft row appears.
- Keep editing focus continuous; next field must stay on same record.
- Esc cancels uncommitted edit.
- Draft row has no Renew/Duplicate/Delete/Snooze actions.
- Exclude draft row from:
  - dashboard counts
  - notifications
  - exports
  - print/PDF
  - sorting
  - data sync payloads
- Never show draft row as an empty saved record.

---

## 5.7 Editing and keyboard behavior

- Click cell then type to edit.
- Double-click / F2 can also edit.
- Enter commits and moves down.
- Tab commits and moves right.
- Esc cancels active edit.
- Delete clears editable cell only; does not delete a row.
- Ctrl+C / Ctrl+V supported through Community-compatible/custom code.
- Paste plain values; do not interpret formulas.
- Ctrl+Z / Ctrl+Y applies to supported edits if available.
- System cells (Days Left, +, row-number gutter) are never editable.

---

## 5.8 Right-click menus

### User-created column header

```text
Rename
Duplicate column
Delete column
```

Admin on Date (Expiry) column additionally sees:

```text
Set as Primary Expiry
```

Rules:

- Days Left and `+` do not show Rename/Delete menu.
- No Hide option.
- If column is already Primary, show it as current state; do not leave app with
  no primary expiry.
- Office cannot change Primary Expiry selection.
- Duplicate column copies:
  - name
  - type
  - options
  It does NOT copy row values.
- Duplicate default name:
  ```text
  Original Name (copy)
  ```
- Deletion always confirms.
- Server checks whether a column contains values across all relevant rows.
- Office can delete only an empty column.
- Admin may delete populated column after strong warning.

### Existing row

```text
Mark as Renewed
Duplicate row
Delete row
Snooze alert
```

Rules:

- Opens from row number or normal data cell.
- Renewal requires usable Primary Expiry.
- Duplicate row copies user values but not ID, deletion state, audit history,
  renewal history, or snooze state.
- Delete performs confirmed soft delete.
- Snooze appears only where reminder is relevant.
- Draft row has no context menu.

---

## 5.9 Empty states

Show only one message at a time:

- No user columns:
  ```text
  Click + to add your first column
  ```
- Columns but no saved entries:
  ```text
  Type in the blank row to add your first entry
  ```
- Filters produce no results:
  ```text
  No records match these filters
  ```

Never show both grid library empty text and application empty text.
Do not cover `+` header or draft row.

---

# 6. Dashboard

## Layout

- Global top bar title: Dashboard.
- Remove duplicate Dashboard/Overview heading, subtitle, Offline-first pill,
  and Export Data button.
- Use available width.
- Avoid large blank margins.

## Cards

First row:

1. Total Entries
2. Expired
3. Expiring Today
4. This Week
5. This Month

Second row:

6. Within 2 Months
7. Within 3 Months
8. Within 6 Months
9. Within 1 Year

Rules:

- Compact cards; target around 80px high on normal desktop.
- Expired/Today visibly emphasized.
- Reflow on smaller windows.
- Cards clickable; open Visa Sheet with matching filter.
- Counts exclude soft-deleted rows and draft row.
- Use Primary Expiry only.
- Range meanings must match report/domain logic.

## Charts

- Left (~40%): Expiry Status donut + legend/counts.
- Right (~60%): Next 12 Months bar chart.
- Stack on smaller windows if needed.
- Status categories are mutually exclusive:
  - Valid
  - Expiring Soon
  - Urgent
  - Expires today
  - Expired
- Records with no valid primary expiry do not get invented into a status.
- Empty state:
  ```text
  No expiry data yet
  ```

---

# 7. Recycle Bin (Admin only)

## Layout

- Global top bar title: Recycle Bin.
- One compact search/count toolbar.
- Full-width table.
- No large header block, breadcrumb, subtitle, or Admin tools label.

Toolbar:

```text
[Search deleted records…]                  N items
```

If 30-day auto-purge is confirmed active, show:

```text
N items · auto-deleted after 30 days
```

If automatic purge is not active, show truthful wording:

```text
N items · kept until permanently deleted
```

## Table

Conceptual columns:

```text
Record | Passport No (if available) | Expiry | Deleted | Purge in (if active) | Actions
```

Rules:

- Resolve Record from available metadata/snapshot:
  - preferred meaningful text field
  - otherwise `Untitled record`
- Never show raw UUID as main label.
- Do not require a fixed Name or Passport column.
- Omit Passport column when not applicable.
- Phone not shown in compact Recycle Bin.
- Expiry: DD/MM/YYYY.
- Deleted: DD/MM/YYYY HH:mm Oman time.
- Newest deletion first.
- Sticky header.
- Short buttons:
  ```text
  [Restore] [Delete]
  ```
- Never append full customer name into every button.
- Prevent duplicate action clicks while operation is running.
- Failure remains visible; do not remove row falsely.

Confirmations:

```text
Restore "[Record label]" to the sheet?
[Cancel] [Restore]
```

```text
Permanently delete "[Record label]"?
This cannot be undone.
[Cancel] [Permanently delete]
```

Empty states:

```text
Recycle Bin is empty
```

```text
No deleted records match this search
```

The permanent delete IPC crash is a non-UI bug in
`docs/RESUME_NEXT_SESSION.md`; fix it before claiming Delete works.

---

# 8. Audit Log (Admin only, read-only)

## Layout

- Global top bar title: Audit Log.
- Compact filter row.
- Full-width table.
- Newest event first.
- Sticky header.
- No Restore/Delete/Clear actions here.

Toolbar:

```text
[Search activity…] [Action ▾] [Date range ▾] [Actor ▾]       N events
```

- Hide Actor filter if it has no useful choices.
- Search friendly record labels, summaries, and file names.

## Table

```text
Time | Actor | Action | Record | Summary
```

Rules:

- Time: DD/MM/YYYY HH:mm Oman time.
- Actor:
  - Admin / Office account
  - actual email available on hover/focus
  - never imply individual identity for shared Office login
  - fallback: `Account unavailable`
  - use `System` only for genuinely system-generated events
- Action: readable colored badge.
- Record: friendly saved label or `—`.
- Summary: readable sentence, not raw JSON.
- Raw event JSON only inside optional Admin details panel.

Example:

```text
21/10/2026 07:45 | Admin | Imported | — | Imported 3 records from test.csv
```

## Details panel

Clicking an event opens side panel:

```text
Field name: old value → new value
```

Rules:

- Resolve fields using available event metadata.
- Do not invent historical names for deleted/renamed columns.
- Optional `View raw` link can show sanitized formatted JSON.
- Never expose tokens/passwords/secrets.

Empty states:

```text
No audit events yet
```

```text
No events match these filters
```

---

# 9. Settings (Admin only)

## 9.1 Layout

Use approved inner navigation layout — no long single scrolling page:

```text
┌──────────────────┬───────────────────────────────────────┐
│ Expiry rules     │  Selected section content              │
│ Notifications    │                                       │
│ Workspace        │                                       │
│ About & updates  │                                       │
└──────────────────┴───────────────────────────────────────┘
```

Rules:

- Global top bar remains visible.
- Inputs max width approximately 320px.
- Responsive: inner navigation/content can stack on narrow windows.
- Remove duplicate headings, Close Settings, Export Data, Offline-first,
  permanent success banner, backup UI, developer Resend text.

## 9.2 Expiry rules

Two editable values:

```text
Urgent threshold:         [30] days
Expiring soon threshold:  [90] days
```

Derived ranges:

```text
Valid          More than 90 days     [green]
Expiring soon  30–90 days            [yellow]
Urgent         1–29 days             [orange]
Expires today  0 days                [red]
Expired        Date has passed       [dark red/gray]
```

Rules:

- Require whole numbers with urgent threshold lower than expiring-soon threshold.
- No range gaps or overlaps.
- Today means `Expires today`, not `Expired`.
- Click color swatch to edit.
- Include small preview of status colors.
- `Reset to defaults` changes form draft only; does not silently overwrite cloud.

## 9.3 Notifications

Reminder chips:

```text
[90 ×] [60 ×] [30 ×] [15 ×] [7 ×] [1 ×] [On expiry day ×] [+ Add day]
```

Rules:

- Whole non-negative values.
- No duplicates.
- Zero displays as `On expiry day`.
- Add/remove affects editable form draft.

Summary settings:

```text
[ ] Daily summary   at [09:00]
[ ] Weekly summary  every [Monday ▾] at [09:00]
```

Rules:

- Show actual saved enabled state.
- These control Windows summaries while DKS is running.
- Do not promise notifications while app is completely exited or PC is off.
- Weekly summary must persist to local cache and Supabase settings.

Email status:

```text
Email notifications not configured. Windows notifications still work.
```

or verified configured state.

No email key field inside desktop app.

## 9.4 Workspace defaults

```text
Currency:        [OMR ▾]     Symbol: [ر.ع.]    Decimals: [3]
Primary expiry:  [Visa Expiry ▾]
Default theme for new sign-ins: [Light ▾]
```

Rules:

- Currency selection can fill symbol/decimals but values remain editable.
- Do not convert old monetary values when currency changes.
- Primary Expiry lists actual Date (Expiry) type columns only.
- Text fields merely named "Visa Expiry" are not valid expiry columns.
- No eligible expiry columns:
  ```text
  No expiry-date columns
  ```
- One eligible expiry column: use canonical automatic Primary Expiry selection.
- Multiple: preserve selected primary; Admin can change it.
- Do not silently replace primary.
- Changing primary recomputes Days Left, colors, status, and reminders.
- Default theme affects new PCs/sign-ins only; personal theme choice wins later.

## 9.5 About and updates

```text
DKS · Version [actual version]          [Check for updates]
Last checked: [actual local time]
```

States:
- checking
- no update
- update available/downloading
- ready to restart
- failed check

Office PCs still receive automatic/background updates even though Office cannot
open Settings.

## 9.6 Settings saving

Use form draft.

When changed:

```text
You have unsaved changes.      [Discard] [Save settings]
```

Rules:

- Discard restores last saved values.
- Save writes locally first and queues cloud sync.
- Prevent duplicate saves while saving.
- If local save fails, show error, not success.
- If cloud pending:
  ```text
  Settings saved locally — waiting to sync
  ```
- Only show cloud success after confirmed acknowledgement.
- Global sync status remains truthful.
- Leaving with unsaved form changes offers:
  ```text
  Save / Discard / Cancel
  ```

---

# 10. Column Setup dialog

Opened by clicking `+`.

```text
Add column

Column name: [e.g. Phone number]
Column type: [Text ▾]

[Cancel] [Add column]
```

Supported types:

- Text
- Number
- Phone
- Email
- Price / Amount
- Date
- Dropdown
- Checkbox
- Notes

Conditional behavior:

- Date:
  ```text
  Start date / Expiry date
  ```
- Dropdown: option input/list.
- Price: defaults to currency from Settings.
- No passport-format checkbox.
- No country-specific validation.

Primary expiry rules:

- First expiry column follows existing automatic-primary logic.
- For later expiry columns, only Admin can set primary.
- Office can add expiry column but cannot replace current primary.
- Duplicate primary expiry column does not automatically become primary.

Dialog behavior:

- Name required and trimmed.
- Preserve entered values after error.
- Prevent duplicate submits.
- Cancel creates nothing.
- Enter submits only when valid.
- Esc cancels.

---

# 11. Other dialogs

## Renewal

```text
Mark as renewed — [Record label]

Current expiry: DD/MM/YYYY or —
New expiry:     [DD/MM/YYYY] [Calendar]

[Cancel] [Renew]
```

- Uses Primary Expiry.
- New date must be future valid date.
- Preserve renewal history and audit logging.
- Prevent duplicate submit.
- Do not create a separate active row.

## Snooze

```text
Snooze alerts for [Record label]

1 day / 3 days / 1 week / Until [DD/MM/YYYY]

[Cancel] [Snooze]
```

- Does not alter expiry.
- Invalid custom date shows warning.

## Print / PDF report (Admin)

Ranges:

```text
[ ] Expiring today
[ ] This week
[ ] This month
[ ] Within 2 months
[ ] Within 3 months
[ ] Within 6 months
[ ] Within 1 year
[ ] Expired
[ ] All entries
```

Columns:
- Dynamic list of actual user-created columns
- Days Left available
- Do not assume Name/Passport/Visa Expiry exists

Rules:

- All entries is mutually exclusive with narrower range filters.
- Avoid duplicate rows from overlapping selections.
- Use same date range logic as Dashboard/domain services.
- Never include:
  - draft row
  - `+` column
  - Actions controls
  - grouping headers
  - deleted records in normal active report

Output:
- DKS header
- generated date/time
- selected range summary
- readable table
- Days Left sorted ascending
- page numbers
- DD/MM/YYYY dates

Buttons:

```text
[Cancel] [Print] [Export PDF]
```

## Import (Admin)

- Select file
- Preview first 20 rows
- Map file columns to actual existing app columns
- Confirm import
- Preserve leading zeroes in text-like values
- Parse/display dates as DD/MM/YYYY
- Show clear row-level mapping/parsing problems
- Do not claim cloud success before operations actually complete

---

# 12. Confirmation dialogs

Row delete:

```text
Move "[Record label]" to the Recycle Bin?
[Cancel] [Delete]
```

Restore:

```text
Restore "[Record label]" to the sheet?
[Cancel] [Restore]
```

Permanent delete:

```text
Permanently delete "[Record label]"?
This cannot be undone.
[Cancel] [Permanently delete]
```

Empty column delete:

```text
Delete column "[Column name]"?
[Cancel] [Delete column]
```

Admin delete populated column:

```text
"[Column name]" contains values in N records.
Deleting it removes these values.
[Cancel] [Delete column]
```

Office denied:

```text
Only an admin can delete a column that contains data.
[OK]
```

Rules:

- Destructive action uses red button.
- Cancel is safe default.
- Escape closes safely.
- Prevent duplicate submissions.
- Show processing/failure state.
- Server determines data count/authorization.

---

# 13. Login and visual branding

The Login screen and final branding system were not reviewed in detail.

Until user gives more direction:

- Keep existing login working.
- Remove obsolete developer placeholder text if present.
- Do not add social login, signup, passwordless login, or guest mode.
- Do not add auth bypass.
- Keep current visual identity consistent.
- Do not invent new logo, fonts, or palette without user approval.
- Use compact spacing, readable contrast, consistent border radius, and
  accessible focus states.

---

# 14. Accessibility and responsive rules

- Icon-only controls have accessible labels and tooltips.
- Keyboard-visible focus on all controls.
- Menus/popovers close on outside click and Escape.
- Dialog focus remains inside dialog and returns to opener when closed.
- Enter confirms only appropriate dialogs/forms.
- Multiline fields allow Enter for new line.
- Use real buttons and proper labels.
- Maintain readable contrast in both themes.
- No essential data hidden solely to force one-screen layout.
- Tables scroll internally.
- Settings/dialogs may scroll when needed.
- Popovers and dialogs remain inside application viewport.
- Overlays must not shift underlying top bar/grid layout.

---

# 15. Verification checklist

## Global

- [ ] Compact top bar on every authenticated page.
- [ ] No breadcrumbs/subtitles/email/logout clutter.
- [ ] Sidebar collapses and remembers state.
- [ ] Office sees only allowed navigation.
- [ ] Real sync state and pending/error details.
- [ ] Bell opens popover without changing top bar height.
- [ ] Theme toggle updates all UI.
- [ ] Avatar popup shows email, role, Logout.

- [ ] (0.1.7 pinned shell) Long page scrolls: sidebar logo/nav and top bar stay in place; only the page area scrolls; no double scrollbar.
- [ ] (0.1.7) Short window (~600px tall): sidebar scrolls on its own; collapsed and expanded sidebar both pinned.
- [ ] (0.1.7) Narrow window (<720px): sidebar stacks above the page and the whole page scrolls (intentional).
- [ ] (0.1.7) Startup with a saved session shows the splash, never a flash of the login form; offline start reaches the login form (with "Retry saved sign-in") within 20s.
- [ ] (0.1.8) After an in-app update the app reopens signed in.

## Visa Sheet

- [ ] Removed buttons/features do not return.
- [ ] One responsive toolbar.
- [ ] Tools only for Admin.
- [ ] Grid fills screen.
- [ ] Row numbers, frozen first data column, sticky header.
- [ ] `+` pinned before Days Left.
- [ ] Draft row creates exactly one record after meaningful input.
- [ ] No row created from focus alone.
- [ ] Draft/system/group rows excluded from export/counts.
- [ ] Right-click column/row menus work.
- [ ] Office edits expiry values but cannot choose primary expiry.
- [ ] No Hide or passport format validation.
- [ ] Dates use DD/MM/YYYY.
- [ ] One context-aware empty state.
- [ ] No AG Grid Enterprise warning/watermark.

## Dashboard

- [ ] Nine statistics retained, compact and responsive.
- [ ] Card filters match labels.
- [ ] Charts use non-overlapping categories.
- [ ] Clean chart empty state.
- [ ] No duplicate page header or Export Data.

## Recycle Bin

- [ ] (0.1.7 pinned shell) Table header stays visible while scrolling a long list (also Audit Log).
- [ ] Friendly labels / truthful fallback.
- [ ] Dates in DD/MM/YYYY HH:mm.
- [ ] Short Restore/Delete actions.
- [ ] Search and empty state.
- [ ] Retention wording truthful.
- [ ] Known permanent-delete bug fixed.

## Audit Log

- [ ] Readable Time / Actor / Action / Record / Summary.
- [ ] Shared Office account not attributed to person.
- [ ] Filters/details panel work.
- [ ] Raw JSON only in optional technical details.
- [ ] Read-only.

## Settings

- [ ] (0.1.7) Settings section nav stays visible while scrolling a long section.
- [ ] (0.1.7) Saving shows one floating toast (does not push content); merely opening Settings shows nothing; errors stay until dismissed.
- [ ] (0.1.7) Notifications tab: skeleton then content; when offline, an error with Retry after ~8s.
- [ ] Inner settings navigation layout.
- [ ] Two-boundary expiry range editor.
- [ ] Expiry today distinct from expired.
- [ ] Reminder chips, daily and weekly schedules.
- [ ] Primary expiry uses actual Date (Expiry) columns.
- [ ] Personal theme not overwritten.
- [ ] Save/Discard and truthful sync feedback.
- [ ] Actual app version/update state.
- [ ] No backup UI.

## Safety

- [ ] Existing customer data is preserved.
- [ ] Pending sync operations are not discarded.
- [ ] No secrets in logs/UI.
- [ ] Tests/typecheck/build pass after each completed phase.

End of UI redesign requirements.