; DKS keeps its SQLite business cache at the root of Electron userData
; ($APPDATA\DKS\dks-cache.sqlite). Never delete that directory or file here.
;
; Session lives in Chromium storages under userData. On Electron 34
; (Chromium 130) the on-disk layout is:
;   %APPDATA%\DKS\Local Storage\leveldb
;   %APPDATA%\DKS\Session Storage
;   %APPDATA%\DKS\IndexedDB
;   %APPDATA%\DKS\Cookies            (legacy file, Chromium <90)
;   %APPDATA%\DKS\Cookies-journal    (legacy)
;   %APPDATA%\DKS\Network\Cookies    (current, Chromium 90+)
;   %APPDATA%\DKS\Network\Cookies-journal
; All must be removed on a REAL uninstall so a later reinstall cannot
; silently restore the previous JWT (Admin AND Office). The SQLite file at
; the userData root (dks-cache.sqlite) must NEVER be touched — it holds
; customer data + outbox. Use SetShellVarContext current to resolve the real
; user's %APPDATA% even if the uninstaller is elevated.
;
; Two cooperating layers:
;   1) NSIS (this file): second layer — deletes the session locations
;      when the old uninstaller runs, after verifying no DKS process is still
;      running (tray counts). Guarded by ${isUpdated} so an in-place
;      auto-update that also runs the old uninstaller does not sign out.
;   2) App-level nonce guard in electron/main/install-nonce.ts: first layer —
;      on every packaged launch compares the install nonce written here (new
;      GUID on fresh install, preserved on update) against the last nonce
;      stored in SQLite. On mismatch it calls session.defaultSession
;      .clearStorageData({ storages: ['cookies','localstorage','indexdb'] })
;      plus Session Storage fs cleanup, before loading the renderer. If
;      cleanup fails it does NOT record the new nonce, so next launch retries
;      and never silently resumes an old session.
; Both layers skip when !app.isPackaged (dev builds).

!include "LogicLib.nsh"

; Fresh install: mint a new install nonce, preserved verbatim on update.
; The main process stores the last seen nonce in SQLite (sync_meta.installNonce)
; and clears session storages when the file's nonce differs or is missing.
; Uses FileExists check (not ${isUpdated} alone) so manual in-place upgrades
; (user runs new exe directly) also preserve the existing nonce. ${isUpdated}
; is only true for auto-updater's --updated launches.
!macro customInstall
  SetShellVarContext current
  CreateDirectory "$APPDATA\DKS"
  ${If} ${FileExists} "$APPDATA\DKS\install-nonce"
    DetailPrint "DKS: preserving existing install nonce (upgrade)"
  ${Else}
    DetailPrint "DKS: creating fresh install nonce"
    ; Full nonce generation: CoCreateGuid creates binary GUID in memory (g .r0),
    ; StringFromGUID2 converts that binary GUID to text and stores it in $1
    ; via t .r1 (NSIS System plugin output). $1 is the GUID string used for
    ; FileWrite. System::Call without explicit return spec pushes nothing, so
    ; no Pop is needed. If GUID generation fails ($1 empty), fall back to
    ; GetTickCount which writes tick count to $1 via i.r1.
    System::Call 'ole32::CoCreateGuid(g .r0)'
    System::Call 'ole32::StringFromGUID2(g r0, t .r1, i 40)'
    ; At this point $1 == GUID text like "{ABCD-...}" from t .r1 above.
    ${If} $1 == ""
      System::Call 'kernel32::GetTickCount() i.r1'
    ${EndIf}
    ; $1 now definitely non-empty (GUID or tick count) — write to file
    FileOpen $0 "$APPDATA\DKS\install-nonce" w
    ${If} $0 != ""
      FileWrite $0 "$1"
      FileClose $0
    ${EndIf}
    ; CI/runtime check: verify install-nonce exists and is non-empty
    FileOpen $0 "$APPDATA\DKS\install-nonce" r
    ${If} $0 != ""
      FileRead $0 $2
      FileClose $0
      ${If} $2 == ""
        DetailPrint "DKS: ERROR install-nonce is empty after write"
      ${Else}
        DetailPrint "DKS: install-nonce created successfully"
      ${EndIf}
    ${Else}
      DetailPrint "DKS: ERROR install-nonce file missing after write"
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Ensure we resolve the real user's %APPDATA%, not an elevated admin's.
    SetShellVarContext current
    FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" w
    FileWrite $R0 "APPDATA=$APPDATA$\r$\n"
    FileWrite $R0 "INSTDIR=$INSTDIR$\r$\n"
    FileClose $R0

    ; Tray Exit must be used before uninstall — a live DKS process holds
    ; Local Storage\leveldb files open, so RMDir would be incomplete and the
    ; next reinstall would auto-login. Use built-in Windows tasklist via nsExec
    ; (available in electron-builder's NSIS) — no external nsProcess plugin needed.
    ; Quote: electron-builder's templates/nsis/uninstaller.nsh invokes
    ;   Section "un.install" {
    ;     !insertmacro customUnInstall
    ;     # delete installed files ...
    ;     RMDir /r $INSTDIR
    ;   }
    ; customUnInstall runs BEFORE file deletion, so the running-app check here
    ; is safe. If it ran after deletion we would need customUnInit instead.
    ; nsExec::ExecToStack pushes two values: exit code and stdout. Pop BOTH.
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq DKS.exe" /FO CSV /NH | findstr /B /I /C:"\"DKS.exe\""'
    Pop $0  ; stdout (CSV line if found, empty if not)
    Pop $1  ; exit code: 0=found (findstr matched), 1=not found
    ; Check both pops: exit code 0 means DKS.exe is running; stdout non-empty also indicates running
    ${If} $1 == 0
    ${OrIf} $0 != ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "DKS is still running. Please right-click the DKS tray icon and choose Exit, then try again.$\r$\n$\r$\nThe uninstaller cannot remove session data while the app is running." /SD IDOK
      Abort
    ${EndIf}

    ; Delete ONLY the Chromium session locations under the real user's
    ; %APPDATA%\DKS. Never touch dks-cache.sqlite, logs/, or other user data.
    ; Robust: delete inner files first with retry for Defender/indexer locks
    DetailPrint "DKS: removing session stores from $APPDATA\DKS (robust)"
    ; Local Storage
    Delete "$APPDATA\DKS\Local Storage\leveldb\*.*"
    Delete "$APPDATA\DKS\Local Storage\*.*"
    RMDir /r "$APPDATA\DKS\Local Storage\leveldb"
    RMDir /r "$APPDATA\DKS\Local Storage"
    ${If} ${FileExists} "$APPDATA\DKS\Local Storage\*.*"
      Sleep 800
      RMDir /r "$APPDATA\DKS\Local Storage"
    ${EndIf}
    ; Session Storage
    Delete "$APPDATA\DKS\Session Storage\*.*"
    RMDir /r "$APPDATA\DKS\Session Storage"
    ${If} ${FileExists} "$APPDATA\DKS\Session Storage\*.*"
      Sleep 800
      RMDir /r "$APPDATA\DKS\Session Storage"
    ${EndIf}
    ; IndexedDB
    Delete "$APPDATA\DKS\IndexedDB\*.*"
    RMDir /r "$APPDATA\DKS\IndexedDB"
    ${If} ${FileExists} "$APPDATA\DKS\IndexedDB\*.*"
      Sleep 800
      RMDir /r "$APPDATA\DKS\IndexedDB"
    ${EndIf}
    ; Cookies may be a directory (old) or file (legacy). Handle both.
    Delete "$APPDATA\DKS\Cookies\*.*"
    RMDir /r "$APPDATA\DKS\Cookies"
    Delete "$APPDATA\DKS\Cookies"
    Delete "$APPDATA\DKS\Cookies-journal"
    ; Current Chromium (Electron 34 / Chromium 130) stores cookies at Network\Cookies.
    Delete "$APPDATA\DKS\Network\*.*"
    Delete "$APPDATA\DKS\Network\Cookies"
    Delete "$APPDATA\DKS\Network\Cookies-journal"
    RMDir /r "$APPDATA\DKS\Network"
    ; Remove install-nonce so next fresh install mints a new GUID and the
    ; app-level guard (install-nonce.ts) detects mismatch vs SQLite's old
    ; nonce and clears any leftover session. Not deleted on update
    ; (${isUpdated} true) — there it is preserved.
    Delete "$APPDATA\DKS\install-nonce"
    FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
    FileWrite $R0 "Delete install-nonce done$\r$\n"
    FileClose $R0
  ${endIf}
!macroend
