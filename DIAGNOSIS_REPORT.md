# DKS Windows Diagnosis — Before Any Code Changes (2026-10-27)

**Branch:** `arena/47255bf3-dks` (from `be808d68` / `v0.1.4`)  
**Date:** 2026-10-27T22:15Z, corrected 2026-10-28  
**Runner:** Linux sandbox, `git fetch --tags` + `gh release view` + `git show`

---

## 1. `git fetch --tags && git tag -l`

```
v0.1.1
v0.1.2
v0.1.3
v0.1.4
```

`origin/main` is at `be808d68` which is `v0.1.4`.

---

## 2. `v0.1.3` vs `v0.1.4` — source at tags

### 2.1 `electron/main/updater.ts`

```bash
git show v0.1.3:electron/main/updater.ts
git show v0.1.4:electron/main/updater.ts
```

**Result: byte-identical source at the two tags.** No diff:

```
git diff v0.1.3..v0.1.4 -- electron/main/updater.ts
# (empty)
```

Relevant excerpts (both tags):

```ts
// createDefaultAdapter
autoUpdater.on('error', () => {
  // Do not forward Error objects or treat this event as final.
  errorListener?.();
});

// UpdaterAdapter.onError is `() => void` — no Error argument.

/**
 * Wrap electron-updater with a no-throw, serializable state machine.
 * No error object is retained or sent to the renderer.
 */
export function createUpdaterService(...) {
  // ...
  try {
    result = await adapter.checkForUpdates();
  } catch {
    return setState({ status: 'error', errorKind: 'check' });
  }
  // ...
  try {
    await adapter.downloadUpdate();
  } catch {
    return setState({ status: 'error', version, errorKind: 'download' });
  }
}
```

`cloneState` only copies `errorKind`, never `error.message`.

**Verdict:** `updater.ts` **source** at both `v0.1.3` and `v0.1.4` tags swallows `Error` and shows the generic pill. However, commit `221d2c2` (`fix: keep downloaded updates ready to install`) **is** in `v0.1.3`'s tagged history (`git tag --contains 221d2c2` includes `v0.1.3`, `v0.1.4`; `git merge-base --is-ancestor 221d2c2 cf8d789` = true), so part of the updater repair *was* built. Without inspecting the actual packaged binary / `app.asar` built on the Windows runner we cannot assert from source tags alone that “no fix was ever built”. Binary/build evidence is required.

### 2.2 `build/installer.nsh`

```nsh
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$APPDATA\DKS\Local Storage"
    RMDir /r "$APPDATA\DKS\Session Storage"
  ${endIf}
!macroend
```

Identical at `v0.1.3` and `v0.1.4` — `git diff` empty. Only 2 storages were removed in source at tags; no `customInstall` nonce, no process guard. Whether the runner’s binary ever contained a different script cannot be determined from tags alone.

### 2.3 `package.json | grep version`

```
v0.1.3: "version": "0.1.3"
v0.1.4: "version": "0.1.4"  (same as HEAD at time of diagnosis)
```

`git diff v0.1.3..v0.1.4 --stat` shows only `ARENA/*, package-lock.json, package.json, src/features/*, tests/*` — no `electron/main/*`, `build/*` source change at tags. Again, binary evidence is separate from tag source.

---

## 3. Updater generic string location

`src/features/settings/SettingsPage.tsx:137-139` (source at tags):

```ts
case 'error':
  return state.errorKind === 'download'
    ? `Update${version} download failed. Check your internet connection and try again.`
    : 'Could not check for updates. Check your internet connection and try again.';
```

`src/lib/types.ts` (`DksUpdateState`) has no `errorMessage`/`errorCode`/`errorName` fields at tags. The pill in `AppShell` renders `updateStatusMessage(state)` from the same source, so every failure is indistinguishable from source.

The main-process `logUpdaterTransition` at tags logs only `{ from, to, version, progress }` — never the updater `Error`.

---

## 4. GitHub v0.1.4 release page — every asset

`gh release view v0.1.4 --json assets`:

| Asset | Size | Created | Updated | contentType |
|-------|------|---------|---------|-------------|
| `DKS-0.1.4-win-x64.exe` | 109,840,018 | 2026-10-27T17:56:09Z | 2026-10-27T17:56:14Z | application/octet-stream |
| `DKS-0.1.4-win-x64.exe.blockmap` | 115,071 | 2026-10-27T17:56:09Z | 2026-10-27T17:56:09Z | application/octet-stream |
| `latest.yml` | 339 | 2026-10-27T17:56:14Z | 2026-10-27T17:56:15Z | text/yaml |

Owner verification (2026-10-28): the public `v0.1.4` installer downloads successfully, **size 109840018 and SHA-512 in `latest.yml` match the actual exe**. An asset mismatch is therefore **not established** for `v0.1.4`. Missing CI hash checks alone do not explain the observed `100%` failure by themselves; a mismatched `latest.yml` ↔ `.exe` remains a hypothesis that requires binary/download evidence.

Attempted in sandbox:

```bash
curl -sL https://github.com/tacenta2k/dks/releases/download/v0.1.4/latest.yml
gh release download v0.1.4 --pattern "latest.yml"
```

Both hit `EOF` here (GitHub’s release-assets redirect requires a live Browser fetch outside the restricted egress allowlist). `gh api .../assets/682404156` digest is `sha256:58a5ebaa...`, but the file body could not be retrieved in this sandbox to independently compare `sha512`/`size`.

What the workflow **did** verify at `v0.1.4` (`.github/workflows/release.yml` → `Verify draft release assets`):

```powershell
gh release view $env:RELEASE_TAG --json tagName,isDraft,isPrerelease,assets,url
# checks tagName == RELEASE_TAG, isDraft == true
# $expectedAssets = @( installer, installer.blockmap, latest.yml )
# downloads latest.yml, checks:
#   contains "version: $version"
#   contains "$installer" name
```

What it **did not** verify at `v0.1.4`:

- That `latest.yml`’s `sha512` equals the `sha512` of the uploaded `DKS-*.exe` **from the same build** (electron-builder writes both in one invocation)
- That `latest.yml`’s `size` equals the exe’s byte length
- That the downloaded `latest.yml` is byte-identical to the local `release/latest.yml` built in the same `npm run release` invocation

Those checks are hardening to prevent a future mismatch, not a claimed fix — v0.1.4 was already proven not mismatched (size 109840018 and SHA-512 matched). The updater is instrumented, not fixed; root cause remains unknown until a real log from the new build is captured.

---

## 5. Session persistence root cause (Bug 1)

- Chromium persists Supabase JWT in `Local Storage\leveldb`, `Session Storage`, `IndexedDB`, `Cookies` under `userData` (`%APPDATA%\DKS`). `dks-cache.sqlite` lives at the **root** of that same directory.
- `electron-builder.yml` has `deleteAppDataOnUninstall: false` (correct — preserves the sqlite file).
- Source `build/installer.nsh` at tags deleted only 2/4 session stores, and only via NSIS. If NSIS skipped (file lock, tray still running) or the app was reinstalled without the file-level guard, the session could survive.
- Source `electron/main/index.ts` at tags never compared an install nonce or called `session.defaultSession.clearStorageData(...)`. A reinstall could therefore restore the prior JWT. Whether a packaged binary at `v0.1.3`/`v0.1.4` contained a partial app-level guard cannot be determined from tags alone; `221d2c2` shows updater state was kept “ready to install” but not session isolation.

---

## 6. Windows-side evidence still to collect (not runnable in this Linux sandbox)

Per original task we should have cleared `%LOCALAPPDATA%\updater*\pending\` and retried `0.1.3 → 0.1.4`, capturing the NEW updater error, and running the downloaded `0.1.4.exe` manually to compare on-disk size vs GitHub (109,840,018). Owner has now confirmed `0.1.4` downloads and its hash matches (see §4). The `100%` failure’s real `error.name/code/message` has not been captured from a packaged Windows run — the new diagnostics only exist in the new build (`v0.1.5` candidate). This report covers every verification runnable in the sandbox.

---

## 7. What will ship in the next version (not a re-tag of `0.1.4`)

- `build/installer.nsh`: `customInstall` preserves existing `install-nonce` via file-existence check (so manual in-place upgrades keep the nonce; `isUpdated` alone would not cover them) and mints a new GUID only when missing; `customUnInstall` verifies no `DKS.exe` is running (tray included) with `nsExec/tasklist/findstr` (built-in, no external nsProcess plugin), aborts if so, then removes the four session locations (accounting for `Network\\Cookies` file vs `Cookies` directory, `Local Storage`, `Session Storage`, `IndexedDB`) plus `install-nonce` so the next fresh install triggers app-level clear. Never touches `dks-cache.sqlite`. Uses `SetShellVarContext current` to resolve the real user’s `%APPDATA%` even if the uninstaller is elevated (with documented UAC limitation: `SetShellVarContext current` does not resolve the original user under 'Run as different user' elevation — that mode is unsupported; installer uses `perMachine: false` / `RequestExecutionLevel user`).
- `electron/main/sqlite.ts`: `getInstallNonce` / `setInstallNonce` in `sync_meta`.
- `electron/main/install-nonce.ts` + `electron/main/index.ts`: on packaged launch, read `$APPDATA\DKS\install-nonce`, compare to stored nonce, on mismatch `await session.defaultSession.clearStorageData(...)` with **documented Electron 34 options** (including `indexdb`) before loading the renderer, and only then persist the new nonce. Skipped when `!app.isPackaged`. If cleanup fails, the new nonce is **not** recorded and the old session is never silently resumed — next launch retries. Preserves login on quit/relaunch, on upgrade from pre-nonce `0.1.3`/`0.1.4`, on `0.1.5` → next-version in-app update, and on manual in-place upgrade; requires email/password only on genuine uninstall/reinstall; Office re-approval expected after reinstall.
- `electron/main/updater.ts`: **instruments** updater to capture `error.name`/`error.code`/`error.message` in `UpdateState.errorMessage` (+ structured fields), logs via `electron-log`, exposes in update pill. This is instrumentation, not a claimed fix — v0.1.4 assets were proven to match `latest.yml` (109840018), so "same-build verification" added in release.yml is hardening, not an established root cause. Root cause remains unknown until a real log from the new instrumented build is captured.
- `src/lib/types.ts` + `src/features/settings/SettingsPage.tsx`: render the real error.
- `.github/workflows/release.yml`: adds hardening verification that `latest.yml` `sha512`/`size` match the built exe and that uploaded `latest.yml` is byte-identical to local `release/latest.yml` from same build; also verifies downloaded assets after upload. **This is hardening, not a root-cause fix** — v0.1.4 was already proven correct on this check.
- Package versioning: `package.json` on this branch is intentionally `0.1.4` (reverted from `0.1.5` in `d350f31`) so the `Release DKS` workflow's `npm version patch` produces `0.1.5` correctly. See `BUGFIX_VERIFICATION.md` §6. Do NOT ship a pre-bumped `0.1.5` — that would cause the next `patch` to skip to `0.1.6`.

Owner will install the `0.1.5` candidate **manually** on Windows first, then publish `0.1.6` from `0.1.5` to prove auto-update installs — per acceptance.

## 8. Windows CI Evidence (2026-10-28)

Branch `arena/47255bf3-dks` CI runs on `windows-2022`:

- 40652834500 0.1.4 success 109597586
- 40662656230 0.1.4 success 109596797 (lenient, with file-lock warnings)
- 40664019128 0.1.5 success 109592303 (current, f93ada2)

All steps: Test ✓, Verify installer nonce (StringFromGUID2 -> FileWrite -> FileRead) ✓, Vite build ✓, Package --win --publish never ✓, NSIS runtime proof ✓ (a-e LOG lines, c warnings are hosted-runner file-lock, not logic failure). MessageBox /SD IDOK fix (836ed9b) prevents silent-uninstall hang.

Owner v0.1.4 public exe 109840018 SHA512 matches latest.yml — no asset mismatch. Missing CI hash checks do not explain 100% failure alone.

