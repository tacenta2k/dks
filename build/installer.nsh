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
