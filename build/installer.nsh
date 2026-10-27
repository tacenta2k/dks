; DKS keeps its SQLite business cache at the root of Electron userData
; ($APPDATA\DKS\dks-cache.sqlite). Never delete that directory or file here.
;
; Session lives in four Chromium storages under userData:
;   %APPDATA%\DKS\Local Storage\leveldb
;   %APPDATA%\DKS\Session Storage
;   %APPDATA%\DKS\IndexedDB
;   %APPDATA%\DKS\Cookies (plus -journal / -wal siblings inside that folder)
; All four must be removed on a REAL uninstall so a later reinstall cannot
; silently restore the previous JWT (Admin AND Office). The SQLite file at
; the userData root must NEVER be touched — it holds customer data + outbox.
;
; Two cooperating layers:
;   1) NSIS (this file): second layer — deletes the four session subfolders
;      when the old uninstaller runs, after verifying no DKS process is still
;      running (tray counts). Guarded by ${isUpdated} so an in-place
;      auto-update that also runs the old uninstaller does not sign out.
;   2) App-level nonce guard in electron/main/index.ts: first layer — on every
;      packaged launch compares the install nonce written here (new GUID on
;      fresh install, preserved on update) against the last nonce stored in
;      SQLite. On mismatch it calls session.defaultSession.clearStorageData
;      for the four storages. That survives an incomplete uninstall.
; Both layers skip when !app.isPackaged (dev builds).

!include "LogicLib.nsh"

; Fresh install: mint a new install nonce, preserved verbatim on update.
; The main process stores the last seen nonce in SQLite (sync_meta.installNonce)
; and clears session storages when the file's nonce differs or is missing.
!macro customInstall
  ${ifNot} ${isUpdated}
    DetailPrint "DKS: creating fresh install nonce"
    CreateDirectory "$APPDATA\DKS"
    ; Generate a GUID via ole32; fall back to tick count if unavailable.
    ; The GUID text is written verbatim to $APPDATA\DKS\install-nonce .
    System::Call 'ole32::CoCreateGuid(g .s)'
    Pop $0
    System::Call 'ole32::StringFromGUID2(g s, t .r1, i 40)'
    Pop $2
    ${If} $1 == ""
      System::Call 'kernel32::GetTickCount() i.r1'
    ${EndIf}
    FileOpen $0 "$APPDATA\DKS\install-nonce" w
    ${If} $0 != ""
      FileWrite $0 "$1"
      FileClose $0
    ${EndIf}
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Tray Exit must be used before uninstall — a live DKS process holds
    ; Local Storage\leveldb files open, so RMDir would be incomplete and the
    ; next reinstall would auto-login.
    nsProcess::FindProcess "DKS.exe"
    Pop $R0
    ${If} $R0 == 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "DKS is still running. Please right-click the DKS tray icon and choose Exit, then try again.$\n$\nThe uninstaller must not remove session data while the app is running."
      Abort
    ${EndIf}

    ; Delete ONLY the four Chromium session subfolders under the real user's
    ; %APPDATA%\DKS. Never touch dks-cache.sqlite, install-nonce, logs/,
    ; or any other file at the userData root.
    RMDir /r "$APPDATA\DKS\Local Storage"
    RMDir /r "$APPDATA\DKS\Session Storage"
    RMDir /r "$APPDATA\DKS\IndexedDB"
    RMDir /r "$APPDATA\DKS\Cookies"

    ; History: older builds left Cookies as a file (not a directory) on some
    ; Windows/Electron combinations. Ensure a stray file is also removed, but
    ; never use a wildcard against $APPDATA\DKS itself.
    Delete "$APPDATA\DKS\Cookies"
  ${endIf}
!macroend
