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
;      Running-app detection: Electron creates %APPDATA%\DKS\running.lock on
;      packaged start and removes it on before-quit; startup deletes any stale
;      lock left after crash (singleInstanceLock guarantees no other instance).
;      Uninstaller prefers tasklist authority: if running.lock exists but
;      tasklist finds no DKS.exe, treat as stale and delete lock to continue.
;      If DKS.exe is running, abort with MessageBox in interactive mode and
;      non-hanging Abort in silent mode (IfSilent). Note: electron-builder's
;      own uninstaller.nsh does CHECK_APP_RUNNING before customUnInstall —
;      in /S it force-kills via KILL_PROCESS, so silent CI cannot observe
;      the Abort; interactive tray-running must be verified manually.
;   2) App-level nonce guard in electron/main/install-nonce.ts: first layer —
;      on every packaged launch compares the install nonce written here (new
;      GUID on fresh install, preserved on update) against the last nonce
;      stored in SQLite, plus a one-shot session-reset-required marker for
;      genuine fresh installs only. On genuine uninstall/reinstall the marker
;      triggers a fail-closed clear of cookies/localstorage/indexdb + Session
;      Storage before renderer loads. Legacy 0.1.4→0.1.5 migration (existing
;      install without nonce) mints a nonce without clearing. See matrix A–F
;      in install-nonce.ts for full behavior.
; Both layers skip when !app.isPackaged (dev builds).

!include "LogicLib.nsh"

Var /GLOBAL isFreshInstall

; Early detection: runs in .onInit after initMultiUser has set
; $hasPerUserInstallation / $hasPerMachineInstallation.
; Determines if this is a genuine fresh install vs upgrade.
;   isUpdated == true → automatic update (electron-updater --updated) → not fresh
;   hasPer* == 1 → existing installation (manual in-place upgrade) → not fresh
;   otherwise → genuine fresh (first install or after genuine uninstall) → fresh
!macro customInit
  StrCpy $isFreshInstall "0"
  ${If} ${isUpdated}
    DetailPrint "DKS: customInit — isUpdated=true (auto-update) → not fresh"
  ${ElseIf} $hasPerUserInstallation == "1"
    DetailPrint "DKS: customInit — existing per-user install detected → not fresh (manual in-place upgrade)"
  ${ElseIf} $hasPerMachineInstallation == "1"
    DetailPrint "DKS: customInit — existing per-machine install detected → not fresh (manual in-place upgrade)"
  ${Else}
    StrCpy $isFreshInstall "1"
    DetailPrint "DKS: customInit — no existing install detected → genuine fresh install (will create session-reset-required)"
  ${EndIf}
!macroend

; Fresh install: mint a new install nonce, preserved verbatim on update.
; For genuine fresh installs (isFreshInstall=1) also create a one-shot
; session-reset-required marker that tells the app to clear session on next launch.
; For upgrades (isFreshInstall=0): preserve existing nonce, or for legacy
; 0.1.4→0.1.5 (no nonce file but existing install) mint a nonce WITHOUT marker
; to migrate without logging out. Never infer fresh solely from FileExists.
!macro customInstall
  SetShellVarContext current
  CreateDirectory "$APPDATA\DKS"
  ${If} $isFreshInstall == "1"
    DetailPrint "DKS: genuine fresh install — creating nonce and session-reset marker"
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
    ; One-shot marker: app clears session then removes this file
    FileOpen $0 "$APPDATA\DKS\session-reset-required" w
    ${If} $0 != ""
      FileWrite $0 "1"
      FileClose $0
      DetailPrint "DKS: session-reset-required marker created"
    ${EndIf}
  ${Else}
    ${If} ${FileExists} "$APPDATA\DKS\install-nonce"
      DetailPrint "DKS: preserving existing install nonce (upgrade)"
      ; Ensure no stale marker lingers from a prior crash
      Delete "$APPDATA\DKS\session-reset-required"
    ${Else}
      DetailPrint "DKS: legacy upgrade detected (no nonce, but existing install) — creating nonce without session reset"
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
          DetailPrint "DKS: ERROR legacy install-nonce is empty after write"
        ${Else}
          DetailPrint "DKS: legacy install-nonce created successfully (no reset marker — login preserved)"
        ${EndIf}
      ${Else}
        DetailPrint "DKS: ERROR legacy install-nonce file missing after write"
      ${EndIf}
      Delete "$APPDATA\DKS\session-reset-required"
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
    ; Running-app guard: running.lock is helper, tasklist is authority.
    ; Check for real DKS.exe process regardless of lock.
    ; If DKS.exe is running → abort (interactive) / silent Abort
    ; If no DKS.exe but lock exists → stale, delete and continue
    ; If neither → continue
    ; Handle tasklist failure explicitly: if nsExec fails (Pop $0 error), treat as check failure and abort if lock exists to be safe, or log and continue? We use explicit branch.
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq DKS.exe" 2>nul | findstr /I "DKS.exe"'
    Pop $0  ; exit code / exec result
    Pop $1  ; output
    ${If} $0 == "error"
    ${OrIf} $0 == ""
      ; tasklist/nsExec failed — log and fall back to lock file check
      FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
      FileWrite $R0 "WARN: tasklist check failed (nsExec error), falling back to lock file$\r$\n"
      FileClose $R0
      ${If} ${FileExists} "$APPDATA\DKS\running.lock"
        FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
        FileWrite $R0 "ABORT: running.lock exists and process check failed — aborting safely$\r$\n"
        FileClose $R0
        IfSilent +2
        MessageBox MB_OK|MB_ICONEXCLAMATION "DKS is still running or cannot be checked. Please exit via tray before uninstalling." /SD IDOK
        Abort
      ${EndIf}
    ${ElseIf} $0 == "0"
      ; DKS.exe is running — block uninstall
      FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
      FileWrite $R0 "ABORT: DKS.exe is running (tasklist found it), blocking uninstall$\r$\n"
      FileClose $R0
      IfSilent +2
      MessageBox MB_OK|MB_ICONEXCLAMATION "DKS is still running. Please exit via tray before uninstalling." /SD IDOK
      Abort
    ${Else}
      ; $0 == "1" → no DKS.exe found
      ${If} ${FileExists} "$APPDATA\DKS\running.lock"
        Delete "$APPDATA\DKS\running.lock"
        FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
        FileWrite $R0 "Stale running.lock deleted - no DKS.exe process$\r$\n"
        FileClose $R0
      ${Else}
        FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
        FileWrite $R0 "No DKS.exe and no running.lock — proceeding$\r$\n"
        FileClose $R0
      ${EndIf}
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
    SetFileAttributes "$APPDATA\DKS\session-reset-required" NORMAL
    Delete "$APPDATA\DKS\session-reset-required"
    nsExec::ExecToStack 'cmd /c del /f /q "$APPDATA\DKS\session-reset-required"'
    Pop $0
    Pop $1
    Delete "$APPDATA\DKS\running.lock"
    FileOpen $R0 "$TEMP\DKS-nsis-debug.txt" a
    FileWrite $R0 "Delete install-nonce done$\r$\n"
    FileClose $R0
  ${endIf}
!macroend
