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
  and manage thresholds and notification days.
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

The release provider is configured explicitly in `electron-builder.yml`
(`publish: provider github, owner tacenta2k, repo dks`) and mirrored by the
`repository` field in `package.json`. The packaged app reads that same
configuration from its generated `app-update.yml`, so installed copies check
GitHub Releases for `tacenta2k/dks`. The repository is public, which is what
lets installed clients read release metadata with no credential — never embed
a token in the app. (If the repository ever becomes private, this update
mechanism stops working for installed clients until releases are hosted
somewhere publicly readable.)

### One-click release (GitHub Actions)

The `Release DKS` workflow builds and publishes the Windows installer from
`windows-latest`, so the owner does not need a local Windows build or a
personal access token. It uses only GitHub's built-in `GITHUB_TOKEN` with
`contents: write` permission.

One-time repository setup:

1. In **Settings → Secrets and variables → Actions → New repository secret**,
   add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Use the same
   public Supabase client values that belong in a local `.env`; never add a
   service-role key, database password, Resend key, personal token, or signing
   credential as a workflow secret for this release process.
2. In **Settings → Actions → General → Workflow permissions**, select
   **Read and write permissions**. The workflow needs that access to push the
   version commit/tag to `main` and publish the verified release. If branch
   protection is enabled for `main`, it must not block the
   `github-actions[bot]` version commit.

To release, merge the workflow to `main`, then use **Actions → Release DKS →
Run workflow**, choose `main`, select `patch`, `minor`, or `major`, and run it.
From a terminal in a checkout of `main`, the equivalent command is:

```bash
gh workflow run release.yml -f bump=patch
```

The workflow checks out `main` with full history, uses Node from `.nvmrc`,
runs `npm ci`, the typecheck, and the test suite with the Node build of
`better-sqlite3`, then creates and pushes the version commit and `v<version>`
tag. It writes the two public Vite values to an uncommitted runner-only
`.env`, runs the existing `npm run release` pipeline (including
`verify:native`, Electron ABI verification, and the `afterPack` ASAR probe),
and uploads a **draft** release. Only after it verifies that the draft has
exactly the installer, its `.blockmap`, and a `latest.yml` for the same
version does it publish the release as the latest release. The installer is
also saved as a workflow artifact.

Installed apps can see an update only after that publish step. They check on
launch and hourly, download in the background, and still install only when the
user chooses **Restart to install**. Draft, failed, or half-uploaded releases
do not reach installed clients.

If a run fails after the version commit and tag have been pushed, the workflow
does not delete them automatically. The simplest recovery is to fix the cause
and run the workflow again: it will bump to the next version and skip the
failed one. Delete any leftover draft release when convenient. To reuse the
same version number instead, first delete the unpublished draft and remote
tag, then revert the bot's version-bump commit on `main` before rerunning:

```bash
gh release delete v<version> --yes
git push origin :refs/tags/v<version>
git tag -d v<version>
```

If the failure happened after the publish step, treat the release as already
live and inspect it before deleting anything.

The installer is currently unsigned. On first install, Windows SmartScreen
may require **More info → Run anyway**; only do that for an installer obtained
from this repository's official GitHub release. Code signing can remove that
warning later, but is not part of this workflow.

### Local Windows release

To publish an update manually: bump `version` in `package.json`
(electron-updater only offers strictly newer versions), then provide a
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
The upload creates a **draft** GitHub release containing the NSIS installer,
`latest.yml`, and the `.blockmap` — all three are required by
electron-updater. Installed apps only see the update **after you press
"Publish release"** on that draft in GitHub. The app then checks on launch
and hourly (and from Settings → About & updates → "Check for updates"),
downloads in the background, and installs only when the user clicks
"Restart to install". Local records live in the per-user app data folder
(`%APPDATA%\DKS`), outside the install directory, and survive updates.
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
