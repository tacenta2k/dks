/**
 * @vitest-environment node
 *
 * H3 guard: the jsdom-only sheet table must be *removed* from production
 * bundles, not hidden with CSS. `__DKS_TEST_SURFACE__` is substituted at build
 * time (false in vite.config.ts, true only in vitest.config.ts) so the bundler
 * can drop the whole block; this test compiles SheetPage both ways and checks
 * the emitted code, and pins the two config files to those values.
 */
import { readFileSync } from 'node:fs';

import { build, stop } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';

const TABLE_MARKERS = ['Visa records table', 'sheet-accessible-table-wrap'];

async function compileSheetPage(testSurface: 'true' | 'false'): Promise<string> {
  const result = await build({
    entryPoints: ['src/features/sheet/SheetPage.tsx'],
    bundle: true,
    write: false,
    absWorkingDir: process.cwd(),
    format: 'esm',
    jsx: 'automatic',
    // Production builds minify; the marker must be gone from the shipped code.
    minify: true,
    loader: { '.css': 'empty', '.png': 'empty', '.jpg': 'empty', '.svg': 'empty' },
    define: { __DKS_TEST_SURFACE__: testSurface, __DKS_VERSION__: '"gate-test"' },
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

// esbuild keeps a long-lived service child process; leaving it running can keep
// the Vitest worker alive past the run.
afterAll(() => {
  stop();
});

describe('jsdom sheet table is build-time only (H3)', () => {
  it('is absent from the production compilation of SheetPage', async () => {
    const production = await compileSheetPage('false');
    for (const marker of TABLE_MARKERS) {
      expect(production.includes(marker), `production bundle still contains "${marker}"`).toBe(false);
    }
  }, 60_000);

  it('is present when the test surface flag is on, so the gate is not a dead end', async () => {
    const test = await compileSheetPage('true');
    expect(test.includes('Visa records table')).toBe(true);
  }, 60_000);

  it('is defined false for builds and true only for Vitest', () => {
    const viteConfig = readFileSync('vite.config.ts', 'utf8');
    const vitestConfig = readFileSync('vitest.config.ts', 'utf8');

    expect(viteConfig).toContain('__DKS_TEST_SURFACE__: JSON.stringify(false)');
    expect(vitestConfig).toContain('__DKS_TEST_SURFACE__: JSON.stringify(true)');
    // No runtime switch may re-enable the table in a packaged build.
    const sheetPage = readFileSync('src/features/sheet/SheetPage.tsx', 'utf8');
    expect(sheetPage).not.toContain("import.meta.env.MODE === 'test'");
  });
});
