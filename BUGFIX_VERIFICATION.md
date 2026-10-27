# Bug Fix Verification — v0.1.5 (Not a Re-tag of 0.1.4)

## Summary

Previous release `v0.1.3` was claimed fixed but `git show v0.1.3:electron/main/updater.ts` and `v0.1.4` are byte-identical, and `build/installer.nsh` never changed. The two-layer fix (NSIS + app nonce) and real error surfacing were never shipped. This branch implements the missing changes for `0.1.5` and preserves `0.1.4` assets intact.

---

## What Was Actually Shipped (pre-fix)

See `DIAGNOSIS_REPORT.md` for full output. Key finding:

- `git diff v0.1.3..v0.1.4 -- electron/main/updater.ts build/installer.nsh` → empty.
- `updater.ts` swallowed `Error` (`onError: () => void`, `catch {}` → generic pill).
- `installer.nsh` deleted only `Local Storage` + `Session Storage`, no process guard, no nonce.
- `latest.yml` verification only checked version string, not `sha512`/`size` or same-build identity.

## Bug 1 — Auto-login After Uninstall/Reinstall

### Root Cause
Chromium session (Supabase JWT) lives in `%APPDATA%\DKS\Local Storage\leveldb`, `Session Storage`, `IndexedDB`, `Cookies`. The NSIS `customUnInstall` was incomplete and had no fallback. A running tray process held `leveldb` files open, so `RMDir` silently failed and the next reinstall auto-logged in as Admin or Office.

### Fix — Two Layers, Neither Deletes `dks-cache.sqlite`

1. **Installer (`build/installer.nsh`) — second layer**
   - `customInstall`: when `${isUpdated}` is false (fresh install, not auto-update), create a new GUID via `ole32::CoCreateGuid` → `$APPDATA\DKS\install-nonce`. On update, preserved.
   - `customUnInstall`: first check `nsProcess::FindProcess "DKS.exe"` → if running, `MessageBox` + `Abort`. Then `RMDir /r` all four: `Local Storage`, `Session Storage`, `IndexedDB`, `Cookies` (+ `Delete Cookies` for legacy file). Never touches `dks-cache.sqlite` or wildcard on `$APPDATA\DKS`.

2. **App (`electron/main/install-nonce.ts` + `electron/main/index.ts`) — first layer**
   - New `install-nonce.ts` helpers: `readInstallerNonce`, `writeInstallerNonce`, `generateInstallNonce`, `enforceSessionIsolation`.
   - `electron/main/sqlite.ts` adds `getInstallNonce()` / `setInstallNonce()` in `sync_meta` (key `installNonce`).
   - In `startMainProcess()`, after `openLocalStore()` and before `createMainWindow()`, call:
     ```ts
     await enforceSessionIsolation({
       isPackaged: app.isPackaged,
       userDataPath: app.getPath('userData'),
       store: localStore,
       session: session.defaultSession,
     });
     ```
     Logic: skip when `!app.isPackaged`; read installer nonce file; if missing, mint one (first launch just stores, subsequent missing file → treat as fresh install); compare to `store.getInstallNonce()`; on mismatch call `session.defaultSession.clearStorageData({ storages: ['localstorage','sessionstorage','indexeddb','cookies'] })` (with fallback to `indexdb` spelling), log, then `store.setInstallNonce(newNonce)`. Never deletes `dks-cache.sqlite`; outbox rows survive (tested).

   Tests: `tests/install-nonce.test.ts` covers dev skip, first launch, match, mismatch (clears + persists), missing file, and that `Cookies`/`IndexedDB` are included.

### How To Verify on Windows (Packaged Builds Only)

1. Fresh install 0.1.5 → shows login screen (Admin & Office separately).
2. Tray → Exit → Windows Add/Remove → Uninstall → reinstall 0.1.5 → still shows login screen (no auto-login). Check `%APPDATA%\DKS\Local Storage` is absent, `dks-cache.sqlite` still present and outbox rows remain.
3. Repeat for Office; after fresh login, Office must re-request approval (new `session_id`).

> **Not yet run on Windows** — this Linux sandbox cannot run `DKS.exe` or read `%APPDATA%`. The Windows steps above must be executed manually before publishing 0.1.6. Do not mark done until logs from `"%APPDATA%\DKS\logs\main.log"` show `[dks] fresh install detected — clearing Chromium session storages`.

---

## Bug 2 — Update Fails at 100%

### Root Cause
Failure was in verify-or-install, not download. Two contributors:
- Generic pill hid the real `electron-updater` error (`Update X download failed. Check your internet...`).
- `latest.yml` was only version-checked, not `sha512`/`size` or same-build identity. If `latest.yml` and `.exe` came from different runs, `electron-updater` would download 100% then fail signature verification — exactly the symptom.

### Fix — Surface Real Error + Build Consistency

1. **`electron/main/updater.ts`**
   - `UpdateState` now carries `errorMessage` (500 chars), `errorCode`, `errorName`.
   - `extractUpdaterError()` + `formatErrorForUi()` bound truncation, no URLs leaked beyond message.
   - `createDefaultAdapter` forwards `autoUpdater.on('error', (error: Error) => { log.error('[dks] updater error event', {name,code,message}); errorListener?.(error) })`.
   - `checkForUpdates()` and `downloadUpdate()` catch blocks log via `electron-log` with `name/code/message` and return `setState({ status:'error', errorKind:'check'|'download', errorMessage, errorCode, errorName })`.
   - `UpdateTransition` also carries error fields; `logUpdaterTransition` logs them under `[dks] updater transition`.
   - `cloneState` preserves new fields.

2. **`electron/preload/index.ts`** — `normaliseUpdateState` passes through `errorMessage/errorCode/errorName`; renderer's `DksUpdateState` extended likewise.

3. **`src/lib/types.ts` + `src/features/settings/SettingsPage.tsx`** — `updateStatusMessage` now shows `Update 0.2.0 download failed: <code: message>` when details exist, else fallback generic. Pill and Settings share same source.

4. **`electron/main/index.ts`** — `logUpdaterTransition` updated to log error fields.

5. **`.github/workflows/release.yml` (Verify draft release assets)**
   - After existing version/name checks, now:
     - Compares uploaded `latest.yml` byte-identical to local `release/latest.yml` (proves same `electron-builder --publish always` invocation).
     - Checks `size:` matches local `DKS-*.exe` `Length`.
     - Computes local exe SHA512 (hex → base64) and verifies it appears in `latest.yml` (either base64 or hex). Fails fast with message explaining `"yml and exe are from different builds — this alone explains 'fails at 100%' during verify-or-install"` if mismatched.

   Tests: `tests/release-workflow.test.ts` now asserts `localLatestYml`, `sha512`, `installerSize` are checked.

### How To Verify on Windows

1. Clear stale cache: `rd /s /q "%LOCALAPPDATA%\updater*\pending\"` (or similar per `electron-updater` cache location) and retry `0.1.3 → 0.1.4`; capture **new** updater error (not generic). In `0.1.5` the pill and `main.log` will show e.g. `ERR_ELECTRON_BUILDER_SIGNED ... sha512 mismatch: expected abc... got def...` (actual code/message from `electron-updater`).
2. From manually installed `0.1.5` (not auto-updated), trigger check: download must complete, then **Install & Restart** succeeds, About shows new version, and no stale session (see Bug 1 check).
3. Confirm `latest.yml` on GitHub: `version: 0.1.5`, `path: DKS-0.1.5-win-x64.exe`, `sha512` base64, `size` == actual exe size (109,840,018 ± build variance). Compare downloaded `DKS-0.1.5-win-x64.exe` file properties size vs GitHub asset size; run `Get-FileHash -Algorithm SHA512` locally and compare to `latest.yml`.

> **Not yet run on Windows** — see below.

---

## Acceptance Checklist (All on Windows Packaged Builds)

- [ ] Fresh install → login screen (Admin). Tray Exit → uninstall → reinstall → login screen again (Admin). Repeat for Office. (`dks-cache.sqlite` preserved, outbox rows intact).
- [ ] From manually installed **0.1.5**, auto-update to the next version: download completes, install succeeds, About shows new version, no stale session above.
- [ ] `dks-cache.sqlite` and unsynced outbox rows survive all of it.

**Real logs required.** If a step wasn't run on Windows, state it plainly. Currently: none of the Windows steps above have been run in this Linux sandbox; manual Windows validation is mandatory before publishing 0.1.6 (`npm run release` with `bump=patch` from 0.1.5).

## Files Changed

- `build/installer.nsh` — nonce generation + process guard + 4 folders.
- `electron/main/install-nonce.ts` — NEW two-layer guard.
- `electron/main/sqlite.ts` — `getInstallNonce`/`setInstallNonce`.
- `electron/main/index.ts` — call `enforceSessionIsolation` before `createMainWindow`, skip when `!isPackaged`.
- `electron/main/updater.ts` — real error surfacing + logging, transition fields.
- `electron/preload/index.ts` — forward new fields.
- `src/lib/types.ts` — `DksUpdateState` error fields.
- `src/features/settings/SettingsPage.tsx` — pill shows real error.
- `electron-builder.yml` — comment update.
- `.github/workflows/release.yml` — same-build sha512/size check.
- `package.json` / `package-lock.json` — bump to `0.1.5`.
- `tests/*` — updated expectations + new `install-nonce.test.ts`.

## Next Action (Owner)

1. Build `0.1.5` locally or via Actions (`workflow_dispatch` bump=patch from `main` at `0.1.5` is actually `0.1.5` itself — you already bumped manually, so next is `0.1.6`).
2. Install `DKS-0.1.5-win-x64.exe` **manually** on Windows, verify Bug 1 acceptance (both roles), collect `main.log` lines for `[dks] install nonce` and `[dks] fresh install detected`.
3. Publish a trivial `0.1.6` (`bump=patch`) from that installed `0.1.5` to prove auto-update installs; verify About shows `0.1.6` and session is not stale.
4. Only then mark acceptance complete.

