# DKS

DKS is an offline-first Electron desktop workspace for medical and visa office
records. STEP 1 provides the reproducible Electron/Vite shell, secure main /
preload boundary, light and dark theme preview, tray lifecycle, and the test
toolchain used by later steps.

## Requirements

- Node.js `20.19.0` (the version is pinned in `.nvmrc`)
- npm 10 or newer
- Windows 10/11 for the NSIS installer; Linux/macOS can run the renderer tests
  and production build
- Python 3, a C/C++ compiler, and `make` when installing `better-sqlite3` from
  source

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

## Run in development

Build the Electron main/preload TypeScript once, start the Vite development
server, and launch Electron with the renderer URL:

```bash
npm run dev
```

The renderer is served at `http://127.0.0.1:5173`. Close the DKS window to
hide it in the tray; use the tray's Exit action to stop the process.

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
