# DKS — Windows startup registration (R3 batch D)

This note explains how DKS registers itself "open at login", how to *inspect*
what Windows currently has (read-only), and how to remove a confirmed stale
entry. Nothing here is executed by the app: DKS never edits the registry
directly and never removes entries it did not create.

## The one mechanism DKS uses

| | |
|---|---|
| Mechanism | Electron `app.setLoginItemSettings` (main process, `configureAutoLaunch`) |
| Where Windows stores it | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\<value name>` |
| Value name | the app name, `DKS` (set by `app.setName('DKS')` in `configureAppIdentity`) |
| Command | `"<install dir>\DKS.exe" --dks-startup=DKS` |
| When it is written | only in a **packaged** build, once at startup |
| Hidden start | never: `openAsHidden: false`, and only an explicit `--hidden` / `--autostart` / `--startup` argument hides the window |

`--dks-startup=DKS` is an inert marker argument. It exists so a DKS entry can be
recognised in the Startup list without guessing: a real DKS registration points
at `DKS.exe` and carries that argument.

**`auto-launch` is no longer a dependency.** It wrote the same Windows Run key
as Electron itself; keeping two writers in the tree is how a PC ends up with
several entries for one app, and it also shipped an unused module.

A development run (`npm run dev`) deliberately writes **nothing**:

- it used to register `node_modules\electron\dist\electron.exe`, which is a
  stale launch target the moment the folder is moved;
- calling `setLoginItemSettings` with `openAtLogin: false` would silently
  remove the installed app's autostart.

The main-process log records the decision at every start:

```text
[dks] startup registration skipped (not a packaged build) { execPath, appName }
[dks] startup registration { appName: 'DKS', execPath: '…\DKS.exe', openAtLogin: true, willLaunchAtLogin: … }
```

Log location (packaged): `%APPDATA%\DKS\logs\main.log`.

## Read-only inspection (PowerShell, no changes)

Run these in a normal PowerShell window. They only read.

```powershell
# 1. Everything Windows will launch at sign-in, with the command it runs.
Get-CimInstance Win32_StartupCommand |
  Select-Object Name, Location, Command |
  Format-Table -AutoSize -Wrap

# 2. Only the entries whose name starts with "Aswin" or contains DKS.
Get-CimInstance Win32_StartupCommand |
  Where-Object { $_.Name -like 'Aswin*' -or $_.Command -like '*DKS*' } |
  Select-Object Name, Location, Command |
  Format-List

# 3. The raw per-user Run key (this is where an Electron registration lives).
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' |
  Select-Object * -ExcludeProperty PS* |
  Format-List

# 4. The Startup folders (shortcuts are separate from Run-key entries).
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup" |
  Select-Object Name, FullName |
  Format-Table -AutoSize

# 5. Does the DKS executable itself report an active login item?
#    (Start DKS once, then read the log line "startup registration".)
Get-Content "$env:APPDATA\DKS\logs\main.log" -Tail 40 |
  Select-String -Pattern 'startup registration'
```

### Deciding which entry is DKS — do not assume

Two entries called **`Aswin`** are *not* proof that either is DKS: the name is
likely the Windows account name and could belong to another application. Decide
from the **command path** in output 1–3:

| What the command points at | Meaning |
|---|---|
| `…\Programs\DKS\DKS.exe` with `--dks-startup=DKS` | a current DKS registration (packaged build) |
| `…\node_modules\electron\dist\electron.exe …` | a stale **development** registration from an older build; safe to remove |
| any other `…\Aswin\…` or unrelated `.exe` | **not DKS** — leave it alone |

A separate `utweb` registry entry is unrelated to DKS and is not touched by
anything in this repository.

## Removing a confirmed stale DKS entry (manual, by you)

Only after output 3 shows the value name and its command points at a path you
have confirmed is an old DKS/electron target:

```powershell
# 1. Back up the current Run key values to a file first (read-only export).
reg export "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" "$env:USERPROFILE\Desktop\dks-run-backup.reg"

# 2. Remove ONE named value (replace <NAME> with the confirmed value name).
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name '<NAME>'

# 3. If the stale entry is a Startup-folder shortcut instead, delete just that
#    shortcut after checking its target:
#    Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
#    Remove-Item '<full path to the confirmed .lnk>'
```

Do **not** delete the whole `Run` key and do not use "Disable all" switches —
other applications keep their entries there.

After removing a stale entry, start the packaged DKS once. It re-registers
itself as `DKS` if "open at login" is what you want; if you would rather it did
not, turn DKS off in Settings → Apps → Startup (Windows) — DKS will not fight
you for it until it is reinstalled or the registration code runs again.
