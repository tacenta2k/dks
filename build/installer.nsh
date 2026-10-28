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
    System::Call 'ole32::CoCreateGuid(g .r0)'
    System::Call 'ole32::StringFromGUID2(g r0, t .r1, i 40)'
    ${If} $1 == ""
      System::Call 'kernel32::GetTickCount() i.r1'
    ${EndIf}
    FileOpen $0 "$APPDATA\DKS\install-nonce" w
    ${If} $0 != ""
      FileWrite $0 "$1"
      FileClose $0
    ${EndIf}
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
    SetShellVarContext current
    FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" w
    FileWrite $R0 "APPDATA=$APPDATA$\r$\n"
    FileWrite $R0 "INSTDIR=$INSTDIR$\r$\n"
    FileClose $R0
    ; Running-app guard: check both tasklist and running.lock to handle
    ; real desktops (tray counts) and stale locks after crash. Electron
    ; creates %APPDATA%\DKS\running.lock on packaged start and removes it
    ; on before-quit; if lock exists but tasklist shows no DKS.exe, the
    ; lock is stale (crash) and is deleted so uninstall is not incorrectly
    ; blocked. Pure FileExists alone would block after crash; pure tasklist
    ; alone misses edge cases where tasklist is unavailable. Both are
    ; Package-safe: uses electron-builder's exact tasklist|findstr pattern.
    ${If} ${FileExists} "$APPDATA\DKS\running.lock"
      FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
      FileWrite $R0 "CHECK running.lock exists, verifying via tasklist$\r$\n"
      FileClose $R0
      nsExec::Exec '"$SYSDIR\cmd.exe" /S /C ""$SYSDIR\tasklist.exe" /FI "IMAGENAME eq DKS.exe" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"DKS.exe\"""'
      Pop $0
      ${If} $0 == 0
        FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
        FileWrite $R0 "ABORT: running.lock + tasklist confirms DKS running$\r$\n"
        FileClose $R0
        IfSilent +2
        MessageBox MB_OK|MB_ICONEXCLAMATION "DKS is still running. Please exit via tray before uninstalling." /SD IDOK
        Abort
      ${Else}
        Delete "$APPDATA\DKS\running.lock"
        FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
        FileWrite $R0 "Stale running.lock deleted (no DKS.exe), proceeding$\r$\n"
        FileClose $R0
      ${EndIf}
    ${EndIf}
    ; Direct tasklist check even without lock (covers old installs pre-lock, or lock deleted)
    nsExec::Exec '"$SYSDIR\cmd.exe" /S /C ""$SYSDIR\tasklist.exe" /FI "IMAGENAME eq DKS.exe" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"DKS.exe\"""'
    Pop $0
    ${If} $0 == 0
      FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
      FileWrite $R0 "ABORT: tasklist shows DKS.exe running$\r$\n"
      FileClose $R0
      IfSilent +2
      MessageBox MB_OK|MB_ICONEXCLAMATION "DKS is still running. Please exit via tray before uninstalling." /SD IDOK
      Abort
    ${EndIf}
    FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
    FileWrite $R0 "CHECK running guard passed, proceeding to cleanup$\r$\n"
    FileClose $R0

    DetailPrint "DKS: removing session stores from $APPDATA\DKS (explicit x)"
    ; Explicitly delete the exact sentinel files used in CI proof, then directories
    SetFileAttributes "$APPDATA\DKS\Local Storage\leveldb\x" NORMAL
    Delete "$APPDATA\DKS\Local Storage\leveldb\x"
    RMDir /r "$APPDATA\DKS\Local Storage\leveldb"
    RMDir /r "$APPDATA\DKS\Local Storage"
    nsExec::ExecToStack 'cmd /c rmdir /s /q "$APPDATA\DKS\Local Storage"'
    Pop $0
    Pop $1
    SetFileAttributes "$APPDATA\DKS\Session Storage\x" NORMAL
    Delete "$APPDATA\DKS\Session Storage\x"
    RMDir /r "$APPDATA\DKS\Session Storage"
    nsExec::ExecToStack 'cmd /c rmdir /s /q "$APPDATA\DKS\Session Storage"'
    Pop $0
    Pop $1
    SetFileAttributes "$APPDATA\DKS\IndexedDB\x" NORMAL
    Delete "$APPDATA\DKS\IndexedDB\x"
    RMDir /r "$APPDATA\DKS\IndexedDB"
    nsExec::ExecToStack 'cmd /c rmdir /s /q "$APPDATA\DKS\IndexedDB"'
    Pop $0
    Pop $1
    SetFileAttributes "$APPDATA\DKS\Cookies" NORMAL
    Delete "$APPDATA\DKS\Cookies"
    RMDir /r "$APPDATA\DKS\Cookies"
    nsExec::ExecToStack 'cmd /c del /f /q "$APPDATA\DKS\Cookies"'
    Pop $0
    Pop $1
    SetFileAttributes "$APPDATA\DKS\Cookies-journal" NORMAL
    Delete "$APPDATA\DKS\Cookies-journal"
    nsExec::ExecToStack 'cmd /c del /f /q "$APPDATA\DKS\Cookies-journal"'
    Pop $0
    Pop $1
    SetFileAttributes "$APPDATA\DKS\Network\Cookies" NORMAL
    Delete "$APPDATA\DKS\Network\Cookies"
    nsExec::ExecToStack 'cmd /c del /f /q "$APPDATA\DKS\Network\Cookies"'
    Pop $0
    Pop $1
    SetFileAttributes "$APPDATA\DKS\Network\Cookies-journal" NORMAL
    Delete "$APPDATA\DKS\Network\Cookies-journal"
    nsExec::ExecToStack 'cmd /c del /f /q "$APPDATA\DKS\Network\Cookies-journal"'
    Pop $0
    Pop $1
    RMDir /r "$APPDATA\DKS\Network"
    nsExec::ExecToStack 'cmd /c rmdir /s /q "$APPDATA\DKS\Network"'
    Pop $0
    Pop $1
    SetFileAttributes "$APPDATA\DKS\install-nonce" NORMAL
    Delete "$APPDATA\DKS\install-nonce"
    nsExec::ExecToStack 'cmd /c del /f /q "$APPDATA\DKS\install-nonce"'
    Pop $0
    Pop $1
    ; Also clean stale running.lock if it survived (should have been handled above, but ensure)
    Delete "$APPDATA\DKS\running.lock"
    FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
    FileWrite $R0 "Delete install-nonce done$\r$\n"
    FileClose $R0
  ${endIf}
!macroend
