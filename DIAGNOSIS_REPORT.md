# DKS Windows Diagnosis — Before Any Code Changes (2026-10-27)

**Branch:** `arena/47255bf3-dks` (from `be808d68` / `v0.1.4`)  
**Date:** 2026-10-27T22:15Z  
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

## 2. `v0.1.3` vs `v0.1.4` — the "fixed" release

### 2.1 `electron/main/updater.ts`

```bash
git show v0.1.3:electron/main/updater.ts
git show v0.1.4:electron/main/updater.ts
```

**Result: byte-identical.** No diff:

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

**Verdict plainly:** `updater.ts` at `v0.1.3` **does NOT contain real electron-updater error logging (codes/messages)**. It still shows the generic swallowed error. The same file ships at `v0.1.4`.

### 2.2 `build/installer.nsh`

```nsh
; DKS keeps its SQLite business cache at the root of Electron userData
; ($APPDATA\DKS\dks-cache.sqlite). Never delete that directory or file here.
;
; Supabase persists its refreshable session in Chromium Local Storage, so a
; real uninstall removes only Chromium's Local Storage and Session Storage
; directories. This prevents a later reinstall from silently restoring the
; old login. ${isUpdated} guard: an in-place app update also runs the old
; uninstaller, and it must not sign the user out.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$APPDATA\DKS\Local Storage"
    RMDir /r "$APPDATA\DKS\Session Storage"
  ${endIf}
!macroend
```

Identical at `v0.1.3` and `v0.1.4` — `git diff` empty.

- Only 2 of the 4 Chromium storages are cleared (missing `IndexedDB`, `Cookies`).
- No `nsProcess`/FindProcess guard for a running DKS tray process.
- No `customInstall` nonce generation at all.

### 2.3 `package.json | grep version`

```
v0.1.3: "version": "0.1.3"
v0.1.4: "version": "0.1.4"  (same as HEAD)
```

`git show v0.1.4` and `git diff v0.1.3..v0.1.4 --stat` confirm the only changes between the two "releases" were:

```
ARENA/*, package-lock.json, package.json (version bump), src/features/admin, src/features/settings, src/features/sheet, tests/*
```

No `electron/main/*`, no `build/*`, no `electron-builder.yml`, no `.github/workflows/release.yml` change. The updater and session fixes claimed for `0.1.3` were **never built into the binary**.

---

## 3. Updater generic string location

`src/features/settings/SettingsPage.tsx:137-139`:

```ts
case 'error':
  return state.errorKind === 'download'
    ? `Update${version} download failed. Check your internet connection and try again.`
    : 'Could not check for updates. Check your internet connection and try again.';
```

`src/lib/types.ts` (`DksUpdateState`) has no `errorMessage`/`errorCode`/`errorName` fields. The pill in `AppShell` renders `updateStatusMessage(state)` from the same source, so every failure is indistinguishable.

The main-process `logUpdaterTransition` logs only `{ from, to, version, progress }` — never the updater `Error`:

```ts
function logUpdaterTransition(transition: UpdateTransition): void {
  log.info('[dks] updater transition', { from: transition.from, to: transition.to, ... });
}
```

---

## 4. GitHub v0.1.4 release page — every asset

`gh release view v0.1.4 --json assets`:

| Asset | Size | Created | Updated | contentType |
|-------|------|---------|---------|-------------|
| `DKS-0.1.4-win-x64.exe` | 109,840,018 | 2026-10-27T17:56:09Z | 2026-10-27T17:56:14Z | application/octet-stream |
| `DKS-0.1.4-win-x64.exe.blockmap` | 115,071 | 2026-10-27T17:56:09Z | 2026-10-27T17:56:09Z | application/octet-stream |
| `latest.yml` | 339 | 2026-10-27T17:56:14Z | 2026-10-27T17:56:15Z | text/yaml |

All three report the same workflow run (5-second window, `github-actions[bot]` uploader, tag `v0.1.4`, `published_at: 2026-10-27T17:56:23Z`). Blockmap precedes the final upload of `latest.yml` by 5s — exactly the order electron-builder publishes them.

`gh release view v0.1.3` shows the same triple (109,833,798 exe, 114,937 blockmap, 339 latest.yml) within the same minute.

### 4.1 `latest.yml` vs `.exe` consistency

Attempted both:

```bash
curl -sL https://github.com/tacenta2k/dks/releases/download/v0.1.4/latest.yml
gh release download v0.1.4 --pattern "latest.yml"
```

Both hit `EOF` in this sandbox (GitHub's release-assets redirect requires a live Browser fetch outside the restricted egress allowlist). The `gh api .../assets/682404156` digest is `sha256:58a5ebaa...`, but the file body could not be retrieved here to compare `sha512`/`size` to the actual exe.

What the workflow **does** verify today (`.github/workflows/release.yml` → `Verify draft release assets`):

```powershell
gh release view $env:RELEASE_TAG --json tagName,isDraft,isPrerelease,assets,url
# checks tagName == RELEASE_TAG, isDraft == true
# $expectedAssets = @( installer, installer.blockmap, latest.yml )
# downloads latest.yml, checks:
#   contains "version: $version"
#   contains "$installer" name
```

What it **does not** verify:

- `latest.yml`'s `sha512` equals the `sha512` of the uploaded `DKS-*.exe`
- `latest.yml`'s `size` equals the exe's byte length
- That the downloaded `latest.yml` is byte-identical to the local `release/latest.yml` built in the same `npm run release` invocation (proving same-build origin vs. a re-tagged artifact)

If the draft was ever re-uploaded from a different run, the current check would still pass, and electron-updater would fail at verify-or-install at 100% — matching the Windows symptom.

`electron-builder.yml`'s `publish.provider: github / owner: tacenta2k / repo: dks / releaseType: draft` is correct; `npm run release` is `npm run verify:native && electron-builder --config electron-builder.yml --publish always` (single build → triple upload). The bug is verification, not upload location.

---

## 5. Session persistence root cause (Bug 1)

- Chromium persists Supabase JWT in `Local Storage\leveldb`, `Session Storage`, `IndexedDB`, `Cookies` under `userData` (`%APPDATA%\DKS`). `dks-cache.sqlite` lives at the **root** of that same directory.
- `electron-builder.yml` has `deleteAppDataOnUninstall: false` (correct — preserves the sqlite file).
- `build/installer.nsh` historically deleted only 2/4 session stores, and only via NSIS. If NSIS skipped (file lock, tray still running), the session survived to the next reinstall, yielding instant auto-login.
- There is **no** app-level guard: `electron/main/index.ts` never compares an install nonce or calls `session.defaultSession.clearStorageData(...)`. A reinstall therefore restores the prior JWT even when the uninstaller failed.

---

## 6. Windows-side evidence still to collect (not runnable in this Linux sandbox)

Per task, before coding we should have cleared `%LOCALAPPDATA%\updater*\pending\` and retried `0.1.3 → 0.1.4`, capturing the NEW updater error (not the generic string), and running the downloaded `0.1.4.exe` manually to compare on-disk size vs GitHub (109,840,018). That step is **not yet done** — it requires a Windows packaged build.

This report covers every verification that **is** runnable in the sandbox. No code changes have been applied yet.

---

## 7. What must ship in 0.1.5 (not a re-tag of 0.1.4)

- `build/installer.nsh`: `customInstall` writes a per-fresh-install nonce (new on `${isUpdated}==false`, preserved on update); `customUnInstall` checks `nsProcess::FindProcess "DKS.exe"` with abort, then `RMDir /r` all four: `Local Storage`, `Session Storage`, `IndexedDB`, `Cookies`. Never touch `dks-cache.sqlite`.
- `electron/main/sqlite.ts`: `getInstallNonce` / `setInstallNonce` in `sync_meta`.
- `electron/main/index.ts`: on packaged launch, read `$APPDATA\DKS\install-nonce`, compare to `store.getInstallNonce()`, on mismatch call `session.defaultSession.clearStorageData({ storages: ['localstorage','sessionstorage','indexeddb','cookies'] })`, then store new nonce. Skip when `!app.isPackaged`.
- `electron/main/updater.ts`: capture `error.name`/`error.code`/`error.message` in `UpdateState.errorMessage` (+ structured fields), log via `electron-log`, expose in the update pill.
- `src/lib/types.ts` + `src/features/settings/SettingsPage.tsx`: render the real error.
- `.github/workflows/release.yml`: verify `latest.yml` `sha512`/`size` match the built exe and that uploaded `latest.yml` === local `release/latest.yml`.
- Bump `package.json` to `0.1.5` (new tag, new draft).

I will install 0.1.5 MANUALLY on Windows first, then publish 0.1.6 from 0.1.5 to prove auto-update actually installs — per your acceptance criteria.

