# Active skills — DKS

Vendored agent guidance. Details, provenance and DKS overrides: `skills/README.md`.
`HANDOFF.md` → `docs/FIXES_UI.md` (LOCKED) → `docs/RESUME_NEXT_SESSION.md` outrank
every skill below. Skills never replace `make test`.

| Skill | Read it when | Skip it when |
| --- | --- | --- |
| `skills/taste-skill/SKILL.md` | Reviewing any screen's visual decisions: type, colour, spacing, chrome. | Changing logic, schema, sync, packaging. |
| `skills/taste-skill/references/app-screens.md` | Building or reworking Dashboard, Sheet chrome, Settings, Recycle Bin, Audit Log, dialogs, empty/loading/error states. Start with §13–§14. | AG Grid cell rendering, column config. |
| `skills/taste-skill/references/{type,colour,layout,copy,critique,tells}.md` | Setting type scale, applying the palette, reviewing a screenshot, writing a UI string. | The LOCKED spec already fixes it. |
| `skills/anti-slop/skills/antislop/SKILL.md` | Always, as the pre-delivery filter (see "Delivery Gate"). | — |
| `skills/anti-slop/skills/antislop-ui/SKILL.md` | Any interface edit: colour, layout, components, dashboard, motion. | — |
| `skills/anti-slop/skills/antislop-human/SKILL.md` | Contrast, keyboard, focus, zoom — check both themes. Run `skills/anti-slop/skills/antislop-human/contrast-check.py`. | — |
| `skills/anti-slop/skills/antislop-copywriting/SKILL.md` | User-facing strings: errors, empty states, confirms, notifications. | Code identifiers, SQL. |
| `skills/anti-slop/skills/antislop-layoutmobile/SKILL.md` | Window-resize behaviour, overflow, tap targets in a resizable desktop window. | Fixed-grid internals. |
| `skills/anti-slop/skills/antislop-code/SKILL.md` | Editing comments inside a diff. Comments only — never the code. | — |

Not available here: taste-skill's `scripts/` and `library/` (need Node 22 + Chrome;
DKS pins Node 20.19.0), and anti-slop's CLI/installer, settings file and MCP server.
Do not run either installer.

One-line activation for a prompt:

> Apply `skills/taste-skill/references/app-screens.md` and the `skills/anti-slop/`
> rules as a review filter; DKS rules in `HANDOFF.md`, `docs/FIXES_UI.md` and
> `docs/RESUME_NEXT_SESSION.md` win any conflict; finish with `make test`.
