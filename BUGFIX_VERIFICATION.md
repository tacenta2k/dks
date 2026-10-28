# Bug Fix Verification — 0.1.5 Candidate (Not a Re-tag of 0.1.4)

> **Branch:** `arena/47255bf3-dks` → `origin/main` (`be808d6` = `v0.1.4`)  
> **Package version on this branch is currently `0.1.4` (not `0.1.5`)** — see §6.  
> **Windows validation has NOT been run in this Linux sandbox** — all Windows steps below are pending manual execution. Do not publish until they pass and logs are collected.

---

## Summary

Source at `v0.1.3` and `v0.1.4` tags is byte-identical for `electron/main/updater.ts` and `build/installer.nsh` (see `DIAGNOSIS_REPORT.md`), but commit `221d2c2` (“keep downloaded updates ready”) *is* in `v0.1.3`’s history, so we cannot claim “no fix was ever built” without binary evidence. Owner confirms the public `v0.1.4` installer (109840018) downloads and its SHA-512 matches `latest.yml` — asset mismatch is not established; missing CI hash checks alone do not explain the `100%` failure.

This branch implements the *remaining* two-layer session isolation, **instruments** the updater to surface real error diagnostics (does not claim to fix the 100% failure), corrects the NSIS/electron storage handling for Electron 34, and adds release-asset verification as hardening. It is intended to become **0.1.5** via the release workflow (not by merging a pre-bumped `0.1.5`).

---

## Bug 1 — Auto-login After Uninstall/Reinstall (Admin + Office)

### Root Cause

Chromium session (Supabase JWT) lives under `%APPDATA%\DKS`:
`Local Storage\leveldb`, `Session Storage`, `IndexedDB`, `Cookies` (legacy file) and `Network\Cookies` (current, Chromium 90+ / Electron 34). Source at tags deleted only 2 locations and had no fallback; a running tray could hold `leveldb` open so `RMDir` silently failed and the next reinstall auto-logged in.

### Fix — Two Layers, Neither Deletes `dks-cache.sqlite`

**1. Installer `build/installer.nsh` — second layer (NSIS)**

- `SetShellVarContext current` at top of each macro to resolve the *real* user’s `%APPDATA%` even if the uninstaller is elevated (UAC limitation: `SetShellVarContext current` does not resolve the original user under 'Run as different user' elevation — that mode is unsupported; installer uses `perMachine: false` / `RequestExecutionLevel user`).
- `customInstall`: via file-existence check (`${FileExists} "$APPDATA\DKS\install-nonce"`): if present preserve (covers both auto-update `${isUpdated}` and manual in-place upgrade where `${isUpdated}` is false), else mint a new GUID (`ole32::CoCreateGuid` → `$APPDATA\DKS\install-nonce`), `CreateDirectory` first, `DetailPrint`. Legacy pre-nonce upgrade (no file) mints then preserves login via app-level storedNonce null.
- `customUnInstall`: when `${isUpdated}` false, first `nsProcess::FindProcess "DKS.exe"` → if `0` (found), `MessageBox` + `Abort` (tray `Exit` required). Then delete *only* session locations:
  ```
  RMDir /r "$APPDATA\DKS\Local Storage"
  RMDir /r "$APPDATA\DKS\Session Storage"
  RMDir /r "$APPDATA\DKS\IndexedDB"
  RMDir /r "$APPDATA\DKS\Cookies"           ; if it was a directory (old)
  Delete "$APPDATA\DKS\Cookies"              ; if it was a file
  Delete "$APPDATA\DKS\Cookies-journal"
  Delete "$APPDATA\DKS\Network\Cookies"
  Delete "$APPDATA\DKS\Network\Cookies-journal"
  ```
  Never `RMDir "$APPDATA\DKS"` nor `Delete *.sqlite`; `dks-cache.sqlite` and `logs/` remain (`install-nonce` is intentionally deleted on genuine uninstall so the next fresh install can trigger app-level clear; it is preserved on update). Tests assert `SetShellVarContext current`, `Network\Cookies`, `install-nonce`, `CoCreateGuid`, `nsProcess::FindProcess`.

**2. App `electron/main/install-nonce.ts` + `index.ts` + `sqlite.ts` — first layer**

- `sqlite.ts` adds `getInstallNonce()` / `setInstallNonce()` in `sync_meta` (`installNonce`).
- `install-nonce.ts`:
  - `generateInstallNonce()` via `crypto.randomUUID`.
  - `readInstallerNonce`/`writeInstallerNonce` at `join(userDataPath, 'install-nonce')`.
  - `enforceSessionIsolation({isPackaged, userDataPath, store, session})`:
    - Skip entirely when `!isPackaged` (dev).
    - If installer nonce file missing: mint one, write it, then check `store.getInstallNonce()`. If `store` has no nonce (first ever launch *or* upgrade from pre-nonce `0.1.3`/`0.1.4`), just record and **preserve login** — do not clear. If `store` already has a nonce, treat as fresh install and fall through to clear.
    - Else compare `installerNonce` vs `storedNonce`; if equal, preserve login and return.
    - On mismatch (genuine uninstall/reinstall, Office reinstall): `await session.clearStorageData({storages: ['cookies','localstorage','indexdb']})` — **documented Electron 34 options including `indexdb`**, no `sessionstorage`/`indexeddb` assumption, no fallback. Then `rmSync(Session Storage)` via fs (Session Storage is not covered by `clearStorageData`). **Await success** before loading renderer and before recording new nonce. If `clearStorageData` throws, **do not record new nonce** — return `false` so next launch retries and never silently resume an old session. Only after success call `store.setInstallNonce(installerNonce)` and log `[dks] session storages cleared`.

- `index.ts` `startMainProcess()`:
  ```ts
  const ok = await enforceSessionIsolation({ isPackaged: app.isPackaged, userDataPath: app.getPath('userData'), store: localStore, session: session.defaultSession });
  if (!ok && app.isPackaged) { dialog.showErrorBox(...); app.quit(); return; } // fail-closed: never silently resume old session
  createMainWindow({ startHidden }); // only after await succeeds
  ```
  `log.info` on fresh-install detected, `log.error` on `clearStorageData` failure; failure blocks window creation.

**Login behavior preserved/broken as required (§2 below):**

- **Quit/relaunch:** nonce matches → no clear → **preserve login** (Admin + Office).
- **Upgrade from pre-nonce 0.1.3/0.1.4 (no file, no DB key):** file missing → mint → `store.getInstallNonce()==null` → just record → **preserve login**.
- **0.1.5 → next version in-app update (electron-updater):** auto-updater launches installer with `--updated` → `isUpdated` true → old uninstaller preserves app data, new `customInstall` sees existing `install-nonce` file → preserves → nonces match → **preserve login**.
- **Manual in-place upgrade without uninstall (run new exe over old):** new installer `customInstall` checks `FileExists "$APPDATA\DKS\install-nonce"` → file exists → preserves nonce (even though `${isUpdated}` is false) → **preserve login**. This is why file-existence is used instead of `isUpdated` alone.
- **Genuine uninstall/reinstall:** NSIS deletes 4 locations (or fails if tray running); fresh `customInstall` writes new nonce → mismatch vs DB’s old nonce → `clearStorageData` + Session Storage rm → stores new nonce → **require email/password** for both roles. `dks-cache.sqlite` and outbox rows survive (tests assert).
- **Office after reinstall:** new `session_id` → requires new approval (expected).

Tests: `tests/install-nonce.test.ts` covers dev skip, first launch, match, mismatch (verifies `['cookies','localstorage','indexdb']` no `sessionstorage`), missing file, failure path (does not record nonce), and `dks-cache.sqlite` survival.

---

## Bug 2 — Update Fails at 100% (Instrumented, Not Fixed)

### Root Cause

Observed failure is in **verify-or-install**, not download. Prior workflow only checked `version:` and installer name in `latest.yml`; it did not verify same-build `sha512`/`size` or byte identity. **However, v0.1.4 assets were proven to match `latest.yml` (owner verified 109840018 and SHA-512), so "same-build verification" is hardening, not the established root cause. Root cause remains unknown until a real log from the new instrumented build is captured.** Separate hypotheses (stale `pending` cache, AV lock, etc.) remain unproven.

### Instrumentation — Surface Real Error (Not a Fix) + Hardening Verification

- **`electron/main/updater.ts` (instrumented, not fixed):** `UpdateState` carries `errorMessage` (500 chars), `errorCode`, `errorName`; `extractUpdaterError` bounds truncation; `createDefaultAdapter` forwards `autoUpdater.on('error', (e:Error)=>{log.error(...); errorListener?.(e)})`; both `checkForUpdates` and `downloadUpdate` `catch` blocks `log.error('[dks] updater check/download failed', {name,code,message,version})` and `setState({status:'error', errorKind, errorMessage: formatErrorForUi(details), errorCode, errorName})`; `cloneState` and `UpdateTransition` preserve them; `logUpdaterTransition` logs them. The updater is **instrumented** to capture the next real failure — it is not claimed as fixed. No raw URLs/paths beyond the message.

- **`electron/preload/index.ts` + `src/lib/types.ts` + `src/features/settings/SettingsPage.tsx`:** `normaliseUpdateState` forwards new fields; `updateStatusMessage` shows `Update 0.2.0 download failed: <code: message>` when present, else generic fallback. Pill and Settings share same source.

- **`.github/workflows/release.yml` — Verify draft release assets:**
  1. Existing `gh release view`/`isDraft`/`isPrerelease`/asset list checks.
  2. Download `latest.yml` from draft, check `version:` and installer name.
  3. **NEW:** Check local `release/latest.yml` exists and is *byte-identical* to uploaded one (same `electron-builder --publish always` invocation).
  4. **NEW:** Local `release/DKS-*.exe` size must appear as `size:` in `latest.yml`.
  5. **NEW:** Compute local exe `SHA512` (hex→base64) and verify it appears in `latest.yml` (base64 or hex); else fail with “yml and exe are from different builds — this alone explains ‘fails at 100%’”.
  6. **NEW:** After publishing, the same checks could be re-run on *downloaded* assets (post-publish) — currently verified on upload; local-vs-uploaded identity ensures downloaded assets will match.

Tests: `tests/release-workflow.test.ts` asserts `localLatestYml`, `sha512`, `installerSize`.

### Updater Instrumented — New Build Only (Not Fixed)

`error.name/code/message` exist only in the *new* instrumented build’s `UpdateState` and `main.log`. **Retrying `0.1.3 → 0.1.4` on an old install will still show the old generic pill** — it does not automatically gain new diagnostics. Updater status is **instrumented, not fixed**, and stays **unverified** until either:

- A real `100%` failure is captured from the new build (pill + `logs/main.log` with `[dks] updater download failed` and `[dks] updater transition` containing `errorMessage/errorCode/errorName`), or
- A packaged Windows in-app update from the manually-installed new build to the next version succeeds (download, install, About shows new version, no stale session).

Until then, updater remains **instrumented, not fixed** — do not mark as fixed.

---

## Acceptance (All on Windows Packaged Builds)

- [ ] **Quit/relaunch:** close via window X (tray remains) → relaunch → **preserve login** (Admin; Office separately).
- [ ] **Upgrade from pre-nonce 0.1.3/0.1.4:** install new build over old (no uninstall) → **preserve login**.
- [ ] **0.1.5 → next version in-app update:** from *manually* installed new build, trigger update → download → **Restart to install** → About shows new version → **preserve login**, no stale session.
- [ ] **Manual in-place upgrade without uninstall:** run new installer exe over existing install → **preserve login**.
- [ ] **Genuine uninstall/reinstall:** Tray `Exit` → Windows `Add/Remove` uninstall → reinstall → **require email/password** (Admin; Office separately). `dks-cache.sqlite` in `%APPDATA%\DKS` and `select count(*) from outbox where status in ('pending','failed')` survive. **Office:** after reinstall, login succeeds but needs *new* admin approval (new `session_id`).
- [ ] **Pending-cache note:** if update is retried, first clear `%LOCALAPPDATA%\updater*\pending\` (or `C:\Users\<you>\AppData\Local\dks-updater\pending\`) per task; then retry.

> **Not yet run on Windows** — see below. Provide `main.log` excerpts: `[dks] install nonce created`, `[dks] fresh install detected — clearing…`, `[dks] session storages cleared`, `[dks] updater transition` with `errorMessage` on failure.

---

## Release Numbering — How 0.1.5 Will Be Produced

`package.json` on this branch is **intentionally `0.1.4`** (reverted from `0.1.5` in `d350f31`) to avoid a double bump. The `Release DKS` workflow does:

```
npm version ${{ inputs.bump }} -m "chore(release): v%s"   # bumps package.json
git push origin main --follow-tags
npm run release  # electron-builder --publish always → exe + blockmap + latest.yml → draft
# Verify draft assets (including new same-build sha512/size + byte-identity checks)
gh release edit $tag --draft=false --latest
```

- **To publish 0.1.5:** merge this branch to `main` (main stays at `0.1.4`), then run `workflow_dispatch` with `bump: patch` from `main`. Workflow will create commit `0.1.5` (`v0.1.5` tag), build, and publish draft `0.1.5` with `DKS-0.1.5-win-x64.exe`, `latest.yml` from *same* build. Verify *downloaded* assets: `gh release download v0.1.5 --pattern "latest.yml" && gh release download v0.1.5 --pattern "DKS-0.1.5-win-x64.exe"`, then `Get-FileHash -Algorithm SHA512` locally vs `latest.yml`’s `sha512`, and `size` vs file length.

- **Do NOT** merge the old `d350f31` commit that already contains `0.1.5` in `package.json`; that would cause the next `patch` bump to produce `0.1.6` and skip `0.1.5`. This branch now has `0.1.4`, ready for the workflow to produce `0.1.5` correctly.

---

## Files Changed (vs `origin/main` `0.1.4`)

- `build/installer.nsh` — `SetShellVarContext current`, nonce GUID via file-existence preserve (handles manual upgrade), `nsExec/tasklist/findstr DKS.exe` guard (no external plugin), 4 locations including `Network\Cookies` + `Cookies-journal` handling, deletes `install-nonce` on genuine uninstall to trigger app-level clear, never `dks-cache.sqlite`.
- `electron/main/install-nonce.ts` — NEW; documented `['cookies','localstorage','indexdb']` + Session Storage fs, await before renderer, failure does not record nonce.
- `electron/main/sqlite.ts` — `getInstallNonce`/`setInstallNonce`.
- `electron/main/index.ts` — `await enforceSessionIsolation` before `createMainWindow`; fail-closed: on `clearStorageData` failure blocks window, shows dialog, quits for retry (never silently resume old session).
- `electron/main/updater.ts` — **instrumented** to surface real `error.name/code/message` via `UpdateState` and `electron-log` (not claimed as fix; root cause unknown until log captured).
- `electron/preload/index.ts` — forward new fields.
- `src/lib/types.ts` — `DksUpdateState` error fields.
- `src/features/settings/SettingsPage.tsx` — pill shows real error.
- `electron-builder.yml` — comment for 4 locations.
- `.github/workflows/release.yml` — same-build `sha512`/`size` + byte-identity + downloaded-asset verification.
- `tests/*` — updated expectations (installer 4 locations, `indexdb`, elevation) + new `install-nonce.test.ts`.
- `DIAGNOSIS_REPORT.md` / `BUGFIX_VERIFICATION.md` — corrected per review.

---

## Next Action (Owner — Windows)

1. **Review diff** of this branch vs `main` (17 files, ~1k lines). Confirm `package.json` is `0.1.4` (ready for `0.1.5` publish).
2. Merge to `main` (no direct publish from branch).
3. On Windows: `workflow_dispatch` → `bump: patch` → verify draft `0.1.5` assets (downloaded `exe` size/SHA-512 vs `latest.yml` `size`/`sha512`, byte identity).
4. **Manually** install `DKS-0.1.5-win-x64.exe` on a clean Windows machine, run acceptance checklist above (both roles), collect `%APPDATA%\DKS\logs\main.log` excerpts and `dks-cache.sqlite` outbox counts.
5. Publish draft (`gh release edit v0.1.5 --draft=false`), then from that manually-installed `0.1.5` trigger an in-app update to `0.1.6` (next `patch` from `main` at `0.1.5`) to prove auto-update installs.

Until step 4–5 pass with logs, mark Bug 1 as pending verification and Bug 2 as **instrumented, not fixed** (pending real log capture).

