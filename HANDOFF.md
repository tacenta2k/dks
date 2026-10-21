# DKS: Project Handoff

Read this file first. Old chat history is not available on other machines.
This file, the git history, and the code are the project memory.

## What DKS is

Windows desktop app (Electron .exe) for a small Oman medical/visa office.
It tracks visa, passport, and document expiry dates in an Excel-like grid.
It uses Supabase for cloud data and an offline SQLite cache.
Two shared logins: ADMIN and OFFICE. Windows notifications, tray icon, auto-update.

## Repo and checkpoint

- Repo: https://github.com/tacenta2k/dks (public), branch: main
- Latest commit: 9c08b5e "wip: checkpoint before moving to new laptop"
  This contains ALL current work, including unfinished sync, conflict, settings, and notification work.
- DO NOT reset or revert to older commits. Continue on top of 9c08b5e.
- Test status at 9c08b5e is NOT yet re-verified on the new machine. Verify first.

## Stack (fixed, do not change)

- Electron + electron-vite, React 18, TypeScript strict, Tailwind (dark/light)
- AG Grid Community (sheet), Zustand (state), date-fns, lucide-react
- @supabase/supabase-js (publishable key only)
- better-sqlite3 (offline cache + outbox), electron-log
- electron-builder (Windows NSIS), electron-updater (GitHub Releases)
- Recharts (dashboard), SheetJS/xlsx (CSV/XLSX), jsPDF + jspdf-autotable (PDF)
- Node pinned to 20.19.0 in .nvmrc
- Dockerfile and Makefile exist only for reproducibility. They are NOT app features and are not needed on Windows.

## Environment

- Create `.env` locally in the project root. NEVER commit it:
  VITE_SUPABASE_URL=https://vjhlccafuqupbxajccvy.supabase.co
  VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_ETVdXQdfIfGeOyICJ-G6Mg_uv24shQk
- The publishable key is public by design. Security comes from RLS in the database.

## Supabase

- Project URL: https://vjhlccafuqupbxajccvy.supabase.co
- Auth users (already created; UUIDs are seeded in schema.sql):
  - ADMIN:  shahabasnavas123@gmail.com   uuid 846536af-f3c6-47c1-8559-d13442c1490a
  - OFFICE: amervisamedical1dks@gmail.com uuid 2a959122-d789-4f2e-8fdf-958260c2e3f9
- User passwords are NOT stored anywhere. The user types them at login. Never ask for them.
- "Automatically expose new tables" is DISABLED. schema.sql MUST keep explicit GRANTs to `authenticated`, or every query fails.
- Never use or request: service_role key, database password, connection string, GitHub token.

## Hard rules (never violate)

1. NO backups of any kind: no automatic CSV/local backup files, no Supabase Storage, no `dks-backups` bucket, no scheduled exports, no "Backup Now" button.
2. CSV/XLSX import and export exist ONLY as manual, admin-only actions the user starts by clicking. No automatic file writes anywhere.
3. ADMIN only: import, export, print/PDF, Settings, Audit Log, Recycle Bin, restore, permanent delete, delete a column that contains data, change which column is Primary Expiry.
4. OFFICE: view, add, edit, duplicate rows; soft-delete with confirmation; add columns; delete a column ONLY if it is empty (server-checked); show/hide/reorder/resize columns; mark renewed; snooze/dismiss alerts. Office CAN type expiry date values in any expiry column. Only choosing the Primary column is admin-only.
5. RLS and server functions enforce every boundary. Hiding a button is not security.
6. Login once per PC. Session persists until the user clicks Logout.
7. No secrets in code or git. `.env` stays gitignored.
8. No formulas in the grid, no attachments, no Outlook/calendar sync, no multi-language.
9. Days Left: computed only from the PRIMARY date_expiry column, always last/far right, locked, not deletable. Uses the local calendar date. Refreshes at midnight.
10. Do not invent features. Ask when unclear.

## Business defaults

- Currency: OMR, symbol ر.ع., 3 decimals (admin can change in Settings)
- Categories: Employee, Family, Client
- Visa types: Visit, Work, Family, Resident
- Visa template columns: Name, Category, Passport No, Visa Type, Country, Visa Expiry, Phone, Notes
- Oman passport: 1 letter + 7 digits, OR 8 digits (case- and space-insensitive). Invalid = red border, never blocks save.
- Duplicate passport: non-blocking yellow warning
- Phone/email: red border if format is invalid
- Alert days: 90, 60, 30, 15, 7, 1, 0
- Row colors: green > 90 days, yellow 30-90, red 1-29, dark red/gray expired. Thresholds are editable by admin.
- Theme default: light

## Status

Verified earlier (reported by the agent):
- Scaffold, tray, close-to-tray, single instance, autostart, themes
- Auth, persisted session, role loading, Logout
- supabase/schema.sql: tables, RLS, RPCs, triggers, seeds
- SQLite store, migrations, outbox, last-write-wins merge, 60s sync, realtime refresh
- AG Grid sheet: add-column wizard, template, row CRUD, duplicate, soft-delete, search, filters, grouping, validation, colors, Days Left, renewal
- Dashboard cards, pie, 12-month bar
- Admin pages: import/export, print/PDF, Recycle Bin, Audit Log
- Notification bell, read/dismiss/snooze, OS toasts

NOT yet verified or finished:
- Conflict handling. Required behavior: row flagged yellow with tooltip "Conflict: also edited elsewhere at [time]", BOTH versions written to audit_log, no silent overwrite.
- Office delete -> admin bell notification -> View / Restore, end to end.
- Settings saved to Supabase and synced across PCs.
- Changing the Primary Expiry column recalculates Days Left and colors.
- Leftover backup code or references (must be zero).
- Final README.
- Live Supabase test (RLS, login, sync between PCs).
- NSIS installer build (`npm run dist`) and install test.

## Remaining work (in order)

1. Run `npm test`, `npm run typecheck`, `npm run build`. Fix failures in place. Do not reset git.
2. Search the repo for: backup, backups, dks-backups, storage.buckets, storage.objects, Backup Now, DKS_Backups. Remove every match, including tests. Commit.
3. Finish conflict handling per the rules above. Commit.
4. Verify admin delete notification flow end to end. Commit.
5. Verify settings sync and Primary Expiry propagation. Commit.
6. Output the final `supabase/schema.sql` in ONE fenced block labeled `PASTE INTO SUPABASE SQL EDITOR`. The user runs it manually.
7. Finalize README: setup, .env, SQL step, roles, free-tier notes, release steps, troubleshooting (SmartScreen, notifications off, offline sync).
8. `npm run dist` to build the NSIS installer. Report the output path.
9. Release steps are documented only; the user runs them.

## Manual steps (USER only; the agent must not attempt these)

- Create `.env` locally (values above).
- Run schema.sql in Supabase Dashboard > SQL Editor > New query > Run.
- Reset both user passwords via Authentication > Users > "Send password recovery". Do NOT delete users.
- Optional email: Resend API key goes in Supabase Edge Function secrets only. The app must work without it.
- Installing the .exe: SmartScreen > More info > Run anyway (unsigned app).
- Windows Settings > System > Notifications > DKS = ON.
- Each PC: log in once with the correct role.
- Releasing: bump version in package.json, set GH_TOKEN in that terminal session only, then `npm run release`. Never commit the token.

## Working rules for the AI agent

- Work phase by phase. After each phase: list changed files, give test steps, then STOP.
- Run tests after every change. Commit each working step.
- Never ask for or accept passwords, service_role keys, DB passwords, or GitHub tokens.
- Do not add Docker, Makefile, backups, or extra services as "requirements".
- If a native module error appears: `npm rebuild better-sqlite3` for tests; `npx electron-builder install-app-deps` for the Electron app.