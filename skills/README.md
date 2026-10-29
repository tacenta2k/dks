# DKS agent skills index

Vendored, read-only guidance for AI coding agents working on this repository.
These files are **reference documents**. They are not application code, not part
of the build, and not a substitute for the DKS test suite or the locked product
rules below.

- **Not shipped in the app.** `electron-builder.yml` sets `files:` to
  `dist-electron/**` and `package.json` only, so nothing in `skills/` reaches the
  installer or the asar.
- **Not tracked as ignored.** `.gitignore` has no `skills/` entry (checked at
  import time), so this folder is committed normally.
- **Read-only by convention.** Do not edit a vendored `SKILL.md` in place to fit
  a task. If a rule is wrong for DKS, the precedence order below decides, and the
  exception belongs in this file — not in the upstream text.

## Precedence — who wins when they disagree

1. `HANDOFF.md` (security, roles, stack, hard rules)
2. `docs/FIXES_UI.md` — **UI Redesign Requirements (LOCKED)**, incl. Section 2
   "Removed Elements — NEVER Reintroduce"
3. `docs/RESUME_NEXT_SESSION.md` — Section 2 "Product requirements that must
   remain true"
4. The skills in this folder
5. The agent's default taste

If a skill tells you to add an element that Section 2 of `docs/FIXES_UI.md`
removed, the LOCKED spec wins and you stop. If a conflict is not covered there,
`docs/FIXES_UI.md` says: stop and ask the user rather than guessing.

## Sources and provenance

Imported: **2026-10-29** on branch `arena/4e296289-dks` (branched from `main` at
`5c8bb72` "chore(release): v0.1.8"). Files copied verbatim; no edits.

| Skill | Source repository | Commit copied from | Commit date | Licence |
| --- | --- | --- | --- | --- |
| `taste-skill/` | https://github.com/leonxlnx/taste-skill | `12af471f627f866411b4bd785b19646d3672784c` ("tasteskill v2.1.5: community fixes (#172)") | 2026-10-25 | MIT, © 2026 Leonxlnx |
| `anti-slop/` | https://github.com/miqdadbadjuber/anti-slop | `3005235d030b4793146ad9afe8d01045efd90e1d` ("roadmap: give v3.2.25 to the installer repairs"), VERSION `3.2.24` | 2026-10-29 | MIT, © 2026 Miqdad Badjuber (antislop) |

Inside `anti-slop/skills/antislop-ui/` and `anti-slop/skills/antislop-human/`, the
`LICENSE-web-quality-skills` file (MIT, © 2026 Addy Osmani) is kept alongside the
skills derived from it. Both `LICENSE` files are copied next to their skill.

26 text files, ~433 KB. No binaries, images, `node_modules`, `package.json`,
`.env`, or lockfiles were copied.

Paths inside the "Copied" blocks below are relative to `skills/`; everywhere
else in this folder, paths are relative to the repository root.

## taste-skill (`skills/taste-skill/`)

`tasteskill v2` — an art-direction and anti-generic-UI skill distilled from a
study of 247 curated gallery sites (One Page Love, Awwwards SOTD). It gives an
agent a deliberate direction instead of the average landing page, enforces a
strict no-ornament house style, and insists the agent look at its own render
before calling the work done.

**Copied**

```
taste-skill/SKILL.md                     the run (10 steps), house rules, laws of the craft
taste-skill/LICENSE                      MIT
taste-skill/references/app-screens.md    dashboards, admin, settings, tables, forms, states  ← most relevant to DKS
taste-skill/references/type.md           scales, tracking, measure, pairing
taste-skill/references/colour.md         palette roles, proportions, tone steps, dark pages, contrast
taste-skill/references/copy.md           the argument, the copy deck, the two-line rule
taste-skill/references/layout.md         grid, margins, rhythm, navigation, footer
taste-skill/references/critique.md       how to look at a screenshot, score it, what to fix first
taste-skill/references/tells.md          dated registry of generated-UI tells
```

**Not copied, and why**

- `scripts/` (`draw.mjs`, `lint.mjs`, `inspect.mjs`, `assets.mjs`, `lib/`) and
  `library/*.json` (~1.5 MB of studied-site data). The scripts need **Node 22+
  and an installed Chrome driven over CDP**; DKS pins Node `20.19.0`
  (`.nvmrc`, `package.json` engines) and its check is `make test`. Adding a
  second Node toolchain to this repo for a design helper is not worth it.
  **Consequence: every `node <skill>/scripts/...` command inside the copied
  `SKILL.md` will fail here.** Use the house-rules table, the laws, and the
  references as a review checklist instead of running the gate.
- `assets/*.css`, `assets/*.js`, `assets/charts.js` — a web marketing
  foundation, not an Electron app shell.
- `references/imagery.md`, `references/motion.md`, `references/scenes.md`,
  `references/research.md` — photograph sourcing, scroll motion and the study's
  benchmark numbers. Little of it transfers to an internal desktop workspace.
  Fetch from upstream if a task genuinely needs them.
- `assets/*.png|webp|svg`, `examples/`, `CHANGELOG.md`, `install.sh`,
  `evals/`, `.claude-plugin/`, `.codex-plugin/`, `.agents/`, `.github/` —
  images, marketing, and installer/plugin plumbing.

**Use it for** — any new or reworked screen surface: Dashboard cards and charts,
the Visa Sheet toolbar and grid chrome, Settings sections, Recycle Bin and Audit
Log tables, dialogs and popovers, empty/loading/error states, theme work
(light/dark). Start with `references/app-screens.md` §13 "House rules for app
screens" and §14 "Tells of generated dashboards", then §3–§8 for shell, KPIs,
charts, tables, forms.

**Do not use it for** — AG Grid internal cell rendering and column
configuration, the preload/IPC bridge, SQLite, Supabase sync, export/print
pipelines, updater and installer logic, or anything where the LOCKED spec in
`docs/FIXES_UI.md` already fixes the layout. Its page/landing-page run (steps 1–6,
direction draws, photograph sourcing) does not apply to DKS at all: DKS is a
compact Windows desktop office app with an Excel-like workspace, explicitly "not
a marketing website or landing page".

**Known friction with DKS.** Its house rules ban thin rules, monospace, gradients,
resting shadows and icon cards. Dense data grids legitimately use borders and
tabular figures — upstream itself exempts "real tables and form fields" and real
interface fragments. Read the rules as *don't decorate a dense workspace like a
landing page*, not as *remove every line from the grid*.

## anti-slop (`skills/anti-slop/`)

`antislop` v3.2.24 — a filter, not a style guide. It stops generic, recognisably
AI-generated UI, copy and code comments without banning techniques outright:
every visual decision must pass a purpose test, and the result must clear a
liveliness bar. Six skills plus a rules pointer.

**Copied**

```
anti-slop/VERSION                                   3.2.24
anti-slop/LICENSE                                   MIT (antislop)
anti-slop/rules/antislop.md                         always-on pointer (generic)
anti-slop/rules/antislop.mdc                        always-on pointer (Cursor frontmatter)
anti-slop/skills/antislop/SKILL.md                  core filter: R-01…R-40, craftsmanship standard, Delivery Gate
anti-slop/skills/antislop-ui/SKILL.md               colour, layout, components, decoration, app & dashboard, motion, performance
anti-slop/skills/antislop-ui/references/CORE-WEB-VITALS.md
anti-slop/skills/antislop-ui/references/WEB-BASELINE.md
anti-slop/skills/antislop-copywriting/SKILL.md      headlines, CTAs, tone, anti-AI-prose patterns
anti-slop/skills/antislop-human/SKILL.md            contrast, keyboard, focus, states, zoom
anti-slop/skills/antislop-human/references/WCAG.md
anti-slop/skills/antislop-human/references/A11Y-PATTERNS.md
anti-slop/skills/antislop-human/contrast-check.py   stdlib-only WCAG contrast checker (--selftest passes here)
anti-slop/skills/antislop-layoutmobile/SKILL.md     breakpoints, scale, grids, overflow, tap targets
anti-slop/skills/antislop-code/SKILL.md             comment hygiene: cut AI-slop comments, keep the useful ones
```

**Not copied, and why**

- `cli/` (`index.mjs`, `lib/install.mjs`, `package.json`, `package-lock.json`)
  and `GUIDE.md` — the `npx antislop-ai` installer and its docs. **Do not run
  the "First-Run Install Wizard" described in `skills/antislop/SKILL.md`, and do
  not write `~/.config/antislop/settings.json` or `%APPDATA%\antislop\` from
  this repo.** This is a vendored copy inside one project, not an install.
- `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, `.kimi-plugin/`,
  `.cline-plugin/`, `.omp-plugin/`, `.agents/`, `plugin.json` — per-agent plugin
  manifests. DKS is not an antislop plugin host.
- `skills/antislop-human/contrast-mcp.py` and the `contrast-mcp-launcher.mjs`
  MCP server — spawns a long-lived server process; the plain `contrast-check.py`
  covers the same arithmetic.
- `scripts/check-repo.mjs`, `scripts/skill-index.mjs`, `.github/`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `ROADMAP.md` — upstream
  repo maintenance and community files.
- `assets/*.png|webp` (~580 KB of banners and before/after screenshots),
  `assets/profile.png`.
- Root `antislop.md` — byte-identical to `skills/antislop/SKILL.md` minus the
  YAML frontmatter, so the `SKILL.md` copy is the single source.

**Use it for** — every UI/copy change in DKS: as a *pre-delivery review filter*.
Practical entry points: `skills/antislop/SKILL.md` → "Delivery Gate";
`skills/antislop-ui/SKILL.md` → "App & Dashboard" and the "UI Skill Checklist";
`skills/antislop-human/SKILL.md` → contrast, keyboard and focus for the light and
dark themes; `skills/antislop-copywriting/SKILL.md` for user-facing strings
(error messages, empty states, confirm dialogs, notification text);
`skills/antislop-code/SKILL.md` when touching comments in a diff.

**Do not use it for** — schema or RLS changes, sync/outbox semantics, updater and
session logic, packaging, or anything in
`docs/RESUME_NEXT_SESSION.md` §11 "User tasks (the agent must not attempt
these)". Also do not use its `during`/`after` mode machinery, its settings file,
or its `anti-slop/audit-001-YYYY-MM-DD.md` report files — for DKS, apply the
rules inline and report findings in the normal PR/commit message. Its web
performance material (Core Web Vitals, LCP/CLS) is context, not a DKS gate;
the DKS gate is `make test`.

## Dangling references in the vendored copies

Both upstream documents cite files that were deliberately not imported. Resolve
them like this instead of assuming they are missing by accident:

- `taste-skill/SKILL.md` cites `scripts/draw.mjs`, `scripts/lint.mjs`,
  `scripts/inspect.mjs`, `scripts/assets.mjs`, `scripts/scenes.mjs`,
  `assets/base.css`, `assets/base.js`, `assets/app.css`, `assets/charts.js`,
  `assets/scenes/`, `library/*` and `references/{imagery,motion,scenes,research}.md`.
  **None exist here.** Skip those steps, or fetch the file from upstream for a
  one-off read; do not vendor the scripts (Node 22 + Chrome requirement).
- The anti-slop skills say "read `antislop.md` (the core)". In this copy the core
  is `skills/anti-slop/skills/antislop/SKILL.md`; upstream's root `antislop.md`
  was byte-identical apart from its YAML frontmatter.
- anti-slop refers to a project-level `DESIGN.md` (direction) and `AGENTS.md` /
  `CLAUDE.md` (routing). DKS has neither by those names. The direction document
  is `docs/FIXES_UI.md`; the routing/hard-rules document is `HANDOFF.md`.
- anti-slop's `during` / `after` mode question and its settings file do not apply
  here. For DKS, apply the filter inline while working and report findings in the
  commit message or PR description.

## Skills are guidance, not proof

A skill cannot tell you whether a change works. The only DKS checks are:

```bash
make test          # strict typecheck + Vitest; also: npm run typecheck && npm test
npm run build      # renderer + Electron main/preload
```

Run those after UI work, per the rules at the top of `docs/FIXES_UI.md`. A design
rule satisfied and a test failing is still a failed change.

## DKS product constraints these skills must not override

Verified in this checkout at import time (`package.json`, `.nvmrc`,
`electron/main/index.ts`, `supabase/schema.sql`, `docs/FIXES_UI.md`,
`docs/RESUME_NEXT_SESSION.md`):

- **Version / stack.** DKS `v0.1.8`. Electron 34, React 18, Vite 5, TypeScript
  strict, AG Grid **Community** 32, Zustand, better-sqlite3, `@supabase/supabase-js`,
  recharts, lucide-react, jspdf + xlsx. Node is pinned to `20.19.0` — do not
  change it, and do not add paid or Enterprise-only libraries.
- **Offline-first.** SQLite is the local cache and sync queue; Supabase Postgres
  is the cloud database. Changes are written locally first and reconciled with
  `updated_at` last-write-wins. UI must be correct in the persisted, offline and
  cloud states.
- **Login preservation (v0.1.8, Issue A).** `flushSessionStorageBeforeInstall()`
  in `electron/main/index.ts` flushes Chromium session storage and cookies
  **before** the update installer starts, because the NSIS installer force-kills
  a lingering `DKS.exe` and a lost refresh-token rotation forces the user to sign
  in again. `before-quit` flushes DOMStorage on every quit path (tray Exit, OS
  shutdown, the updater's own `app.quit()`). Separately, the install-nonce
  session-isolation guard wipes the Chromium session storages on a real
  uninstall/reinstall and **blocks launch** rather than silently resuming an old
  session. Nothing in a UI change may move, rename, re-scope or clear that
  session storage — no new `clearStorageData()`, no partition change, no moving
  auth state out of the Supabase client's storage.
- **RLS and roles.** `supabase/schema.sql` enables RLS on `profiles`,
  `app_columns`, `entries`, `renewals`, `audit_log`, `admin_notifications`,
  `settings`, `alert_snoozes`, `sync_sessions`, `office_signin_requests` and
  `dks_private.office_entry_soft_delete_context`. Admin/Office boundaries are
  enforced with RLS **and** server-side functions **and** role checks in the
  IPC/service layer — hiding a button is not sufficient. Admin-only:
  import/export, print/PDF, primary-expiry-column choice, thresholds, recycle
  bin, audit log. Never weaken login, RLS or production security to make tests
  pass, and never ask the user for passwords or secret keys.
- **Renderer isolation.** The renderer never receives a Node or database handle;
  all local persistence crosses the context-isolated preload bridge.
- **LOCKED UI spec.** `docs/FIXES_UI.md` Section 2 lists elements that must
  never be reintroduced — breadcrumbs, `WORKSPACE`/`OVERVIEW`-style eyebrow
  labels, developer text such as `STEP 2 · Role-gated workspace`, the decorative
  `Offline-first` pill, a standalone top-bar Log out button, visible email in the
  top bar, `Add Row`/`Add Column`/`Manage Columns` toolbar buttons, an `Actions`
  grid column, backup controls, and raw UUIDs / raw ISO timestamps / raw JSON in
  normal UI. (Note the overlap: taste-skill also bans eyebrows, and DKS already
  banned them — agree.)
- **Presentation rules.** Compact Windows desktop app, efficient screen space, no
  narrow centred containers, no large empty areas, the grid is the focus on the
  Visa Sheet, one compact global top bar, popovers instead of expanding top-bar
  text, no duplicate controls, admin features fully hidden for Office users,
  light **and** dark themes consistent. Visible dates `DD/MM/YYYY`; visible
  date/time `DD/MM/YYYY HH:mm` in Oman time (`Asia/Muscat`).
- **Data honesty.** No fake data, no seeded example people, no deleted user data,
  no invented statistics or testimonials. `Days Left` is computed from the
  primary expiry column and stays the locked final grid column.
- **Scope.** No new pages, buttons, controls, business columns or features. No
  automatic backups of any kind. The repository is public: never commit `.env`,
  secrets, or real customer records.
- **Do not touch** (outside the skills/ folder itself): application code, tests,
  release workflows, `supabase/schema.sql`, updater logic, session handling.
