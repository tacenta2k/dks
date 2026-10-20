# DKS Hardening and Production Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove backup behavior, correct office expiry editing, finish cloud-backed settings and notifications, and make production safety and packaging verifiable.

**Architecture:** Keep local SQLite as the offline cache and Supabase as the only remote source of truth. The renderer uses the existing context-isolated preload API; settings, notifications, and sync state cross explicit serializable boundaries. Database-side role rules remain authoritative and renderer checks are only UX.

**Tech Stack:** Electron, React, TypeScript, Supabase JS/Postgres RLS, better-sqlite3, Vitest, React Testing Library, electron-builder.

**Spec:** User request in the chat beginning “Continue from commit f413d3e”.

## Global Constraints

- Data persists only in Supabase and the local SQLite offline cache; no backup files or storage bucket remain.
- Office users may edit expiry values in every expiry column, including the primary one; only primary-column selection is administrator-only.
- Demo mode is unavailable in production builds; missing Supabase configuration shows a clear error screen.
- Never add service-role keys, passwords, or `GH_TOKEN` values to the repository.
- After every part, run `npm test`, `npm run typecheck`, and `npm run build`, then commit that working part.

## Review Focus

- Existing SQLite users must open after the notification schema migration and retain notification state.
- Office editing must not permit changing which expiry column is primary or bypass server-side RLS/triggers.
- A settings write that fails remotely must not be reported as saved or silently discard the previous value.
- Realtime office-delete notifications must identify the row and timestamp and offer View, Restore, and Dismiss.
- A sync conflict or failed push must remain visible with pending data instead of being silently overwritten.

---

### Task 1: Remove backups completely

**Files:**
- Delete: `electron/main/backup.ts`
- Modify: `supabase/schema.sql`, `electron/main/local-ipc.ts`, `electron/main/index.ts`, `electron/preload/index.ts`, `src/lib/types.ts`, settings components, README, and affected tests.
- Test: backup absence, IPC surface, settings surface, and schema assertions.

- [ ] Add failing assertions that the bucket/policies, backup IPC methods, backup preload methods, backup settings UI, and backup module are absent.
- [ ] Remove the backup source, IPC handlers, bridge methods, settings props/UI, and documentation; preserve SQLite and Supabase data paths only.
- [ ] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Commit with `refactor: remove backup features`.

### Task 2: Correct office expiry editing

**Files:**
- Modify: sheet grid/editability logic and `supabase/schema.sql`.
- Test: office primary-expiry value editing, Mark as Renewed, and admin-only primary selection.

- [ ] Add a failing renderer/domain test for office edits to `date_expiry` values and a schema assertion that office users are not blocked from entry expiry updates.
- [ ] Make all expiry value cells editable for office users while retaining administrator-only primary-column choice.
- [ ] Update RLS/triggers so office entry updates can change expiry values but cannot change `app_columns.is_primary_expiry`.
- [ ] Run the three required checks and commit with `fix: allow office expiry value edits`.

### Task 3: Persist settings through Supabase

**Files:**
- Modify: settings types/UI, Supabase client typing, renderer sync/bootstrap, SQLite settings metadata if needed, and tests.

- [ ] Add failing tests for read-on-start, save-on-change, remote failure retention, and cross-device refresh of thresholds, colors, notification days, currency, theme default, and primary expiry.
- [ ] Implement typed settings serialization and authenticated Supabase upsert/select with local-first cache and visible errors.
- [ ] Refresh settings on startup and realtime `settings` changes; apply primary-expiry selection through the existing guarded path.
- [ ] Run the three required checks and commit with `feat: persist settings through Supabase`.

### Task 4: Finish office-delete and conflict safety

**Files:**
- Modify: schema notification triggers/policies, notification serialization/UI, sync conflict handling, and renderer state.
- Test: office-delete realtime notification with View/Restore/Dismiss and visible conflict/pending state.

- [ ] Add failing tests for the notification payload/action behavior and conflict error/pending-state behavior.
- [ ] Implement server-side notification creation, realtime refresh, actions, and explicit no-silent-loss conflict feedback.
- [ ] Run the three required checks and commit with `feat: surface delete alerts and sync conflicts`.

### Task 5: Enforce production safety and clean-install guidance

**Files:**
- Modify: `src/renderer/App.tsx`, auth/error UI, README, and security/clean-install tests or scripts.

- [ ] Add failing tests proving production builds do not expose demo continuation and missing Supabase configuration renders an error state.
- [ ] Gate demo mode on development/test only, scan the repository for forbidden secret patterns, and document Node `20.19.0`, `npm ci`, and `electron-builder install-app-deps`.
- [ ] Run the three required checks and commit with `fix: harden production startup`.

### Task 6: Package and final review

**Files:**
- Modify: README and any packaging configuration required for the installer.

- [ ] Verify `npm ci` under Node `20.19.0`, run `electron-builder install-app-deps`, and run `npm run dist`.
- [ ] Record the exact `release/DKS-Setup-*.exe` path, inspect status/diff, and run the final review checks.
- [ ] Print the complete `supabase/schema.sql` in the final response under the exact requested fence label and provide the office/admin checklist.
