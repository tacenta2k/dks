# DKS

DKS is an offline-first Electron desktop workspace for an Oman medical and visa
office. It provides a role-gated visa sheet, local SQLite persistence, Supabase
reconciliation, expiry alerts, Windows notifications, dashboards, and admin
reporting/export tools. The renderer never receives a Node or database handle;
all local persistence crosses the context-isolated preload bridge.

## Requirements

- Node.js `20.19.0` (the version is pinned in `.nvmrc`)
- npm 10 or newer
- Windows 10/11 for the NSIS installer; Linux/macOS can run the renderer tests
  and production build
- Python 3, a C/C++ compiler, and `make` when installing `better-sqlite3` from
  source

The project pins Node `20.19.0` because the native SQLite dependency must be
built against the runtime that launches Electron. Do not install dependencies
globally or use `sudo`; the Dockerfile installs the Linux build toolchain inside
the container.

Use the pinned runtime with nvm:

```bash
nvm install
nvm use
node --version
```

The final command should print `v20.19.0`.

## Setup

Install the exact locked dependency graph:

```bash
npm ci
```

Copy `.env.example` to `.env` if local Supabase configuration is needed:

```bash
cp .env.example .env
```

Only the Supabase URL and publishable key belong in this file. Do not put a
service-role key, database password, token, or signing credential in the
repository or renderer configuration.

For a configured cloud workspace, create the two Auth users first and then run
`supabase/schema.sql` in the Supabase SQL editor. The script seeds the exact
admin and office profile IDs required by DKS and enables authenticated-only RLS.
The app can still run its local/demo workflow when Supabase is not configured.

## Run in development

Build the Electron main/preload TypeScript once, start the Vite development
server, and launch Electron with the renderer URL:

```bash
npm run dev
```

The renderer is served at `http://127.0.0.1:5173`. Close the DKS window to
hide it in the tray; use the tray's Exit action to stop the process.

## User flows

- **Office users** can maintain rows, use search/status/category filters, renew
  visas, and delete only empty non-primary columns.
- **Administrators** can change the primary expiry column, import CSV/XLSX,
  export CSV/XLSX, print or save PDF reports, inspect the recycle bin/audit log,
  manage thresholds and notification days, and create backups.
- The sheet's primary expiry column drives `Days Left`, status colors, the
  dashboard, in-app notification bell, OS notifications, and daily/weekly
  summary records.
- Changes are written to the local SQLite cache first. When an authenticated
  Supabase connection is available, the app reconciles entries and columns with
  `updated_at` last-write-wins semantics, keeps the outbox idempotent, and
  refreshes the visible sheet after realtime or scheduled sync.

## Checks and tests

The single offline-capable check is:

```bash
make test
```

It runs strict renderer and Electron typechecks followed by the Vitest suite.
After `npm ci`, these commands do not require a network connection:

```bash
npm run typecheck
npm test
```

For a production compile without packaging:

```bash
npm run build
```

The renderer is emitted to `dist-electron/renderer`, while Electron main and
preload bundles are emitted to `dist-electron/main` and `dist-electron/preload`.
This matches the paths consumed by `electron/main/index.ts`.

## Windows distribution and release

Build the local NSIS installer on Windows:

```bash
npm run dist
```

Artifacts are written to `release/`. The builder metadata uses app id
`com.dks.tracker` and product name `DKS`.

To publish a GitHub release, configure the repository owner/name through the
repository metadata or the electron-builder environment, then provide a
short-lived token only in the shell and run:

PowerShell:

```powershell
$env:GH_TOKEN = "<temporary-github-token>"
npm run release
Remove-Item Env:GH_TOKEN
```

Command Prompt:

```bat
set GH_TOKEN=<temporary-github-token>
npm run release
set GH_TOKEN=
```

Never save `GH_TOKEN` in `.env`, `package.json`, CI logs, or committed files.
Linux can run the compile and tests; producing the configured Windows NSIS
installer requires Windows tooling (or a separately configured Wine build
environment).

## Docker

The Docker image installs the native build toolchain, runs `npm ci`, builds the
renderer and Electron bundles, and serves the production renderer preview:

```bash
docker build --tag dks:local .
docker run --rm --publish 4173:4173 dks:local
```

Open `http://localhost:4173` to inspect the built renderer. A desktop Electron
window is launched outside the container with `npm run dev` or the packaged
Windows executable.

## Project layout

- `src/renderer/` — React renderer entry and UI shell
- `electron/main/` — Electron lifecycle, tray, notifications, and updater
- `electron/preload/` — context-isolated renderer bridge
- `tests/` — offline Vitest and React Testing Library tests
- `vite.config.ts` / `tsconfig*.json` — renderer and Electron build boundaries
- `electron-builder.yml` — DKS Windows packaging metadata
