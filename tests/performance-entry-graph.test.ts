/**
 * @vitest-environment node
 *
 * H1 guard: what the startup path is allowed to pull in.
 *
 * The renderer entry is bundled here with the same module resolution the app
 * uses (esbuild) and the *static* import graph is walked from
 * `src/renderer/main.tsx`. Anything reachable only through `import()` is
 * deferred to the action that needs it. This mirrors the production build and
 * fails if a screen or a heavy library drifts back onto the startup path,
 * which would make sign-in fetch and parse code it never uses.
 *
 * The real Vite build asserts the same thing on its emitted chunks
 * (`forbidSheetTestSurface` in vite.config.ts) — this test keeps the signal
 * inside `npm test`.
 */
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ENTRY = 'src/renderer/main.tsx';

/** Libraries that must not be loaded to sign in, restore a session, or show the shell. */
const DEFERRED_LIBRARIES = [
  'ag-grid-community',
  'ag-grid-react',
  'recharts',
  'xlsx',
  'jspdf',
  'jspdf-autotable',
  'html2canvas',
];

/** Screens that must arrive as chunks, never with the entry. */
const DEFERRED_SCREENS = [
  'src/features/sheet/SheetPage.tsx',
  'src/features/dashboard/DashboardPage.tsx',
  'src/features/settings/SettingsPage.tsx',
  'src/features/admin/AdminTools.tsx',
];

interface Graph {
  inputs: Record<string, { imports: { path: string; kind: string }[] }>;
  entry: string;
}

const STATIC_KINDS = ['import-statement', 'require-call'];
const ALL_KINDS = [...STATIC_KINDS, 'dynamic-import'];

async function entryGraph(): Promise<Graph> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    metafile: true,
    absWorkingDir: process.cwd(),
    format: 'esm',
    jsx: 'automatic',
    // The renderer imports its stylesheets and logo PNGs; they carry no JS and
    // are irrelevant to the module graph under test.
    loader: { '.css': 'empty', '.png': 'empty', '.jpg': 'empty', '.svg': 'empty' },
    define: {
      __DKS_TEST_SURFACE__: 'false',
      __DKS_VERSION__: '"bundle-graph-test"',
      'import.meta.env.MODE': '"production"',
    },
    logLevel: 'silent',
  });

  const inputs = result.metafile?.inputs ?? {};
  // esbuild reports module ids with the host separator; every match below is
  // done on '/'-joined ids so the graph test behaves the same on Windows.
  const entry = Object.keys(inputs).find((id) => normalise(id).endsWith(ENTRY));
  if (!entry) {
    throw new Error(`esbuild did not report the renderer entry ${ENTRY}`);
  }
  return { inputs, entry };
}

function normalise(moduleId: string): string {
  return moduleId.replace(/\\/g, '/');
}

function reachable(graph: Graph, kinds: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [graph.entry];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id) || !graph.inputs[id]) {
      continue;
    }
    seen.add(id);
    for (const imported of graph.inputs[id].imports) {
      if (kinds.includes(imported.kind)) {
        stack.push(imported.path);
      }
    }
  }
  return seen;
}

function packageOf(moduleId: string): string | null {
  const marker = 'node_modules/';
  const normalised = normalise(moduleId);
  const index = normalised.indexOf(marker);
  if (index === -1) {
    return null;
  }
  const rest = normalised.slice(index + marker.length);
  return rest.startsWith('@') ? rest.split('/').slice(0, 2).join('/') : rest.split('/')[0];
}

describe('renderer startup module graph (H1)', () => {
  it('never statically imports a screen or a heavy library from the entry', async () => {
    const graph = await entryGraph();
    const staticModules = [...reachable(graph, STATIC_KINDS)];

    const staticHeavy = [...new Set(staticModules.map(packageOf).filter(Boolean))]
      .filter((name) => DEFERRED_LIBRARIES.includes(name as string));
    expect(staticHeavy).toEqual([]);

    const staticScreens = DEFERRED_SCREENS.filter((screen) => staticModules.some((id) => normalise(id).endsWith(screen)));
    expect(staticScreens).toEqual([]);

    // The admin barrel re-exports the whole AdminTools module; importing it
    // anywhere on the startup path would drag XLSX/PDF wiring back in.
    expect(staticModules.some((id) => normalise(id).endsWith('src/features/admin/index.ts'))).toBe(false);
  }, 60_000);

  it('still reaches those screens and libraries through dynamic imports', async () => {
    const graph = await entryGraph();
    const allModules = [...reachable(graph, ALL_KINDS)];

    const reachableHeavy = new Set(allModules.map(packageOf).filter(Boolean) as string[]);
    for (const library of DEFERRED_LIBRARIES) {
      expect(reachableHeavy.has(library), `${library} should still be reachable as a chunk`).toBe(true);
    }
    for (const screen of DEFERRED_SCREENS) {
      expect(allModules.some((id) => normalise(id).endsWith(screen)), `${screen} should be a chunk`).toBe(true);
    }
  }, 60_000);
});
