import { readFileSync } from 'node:fs';

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const packageVersion = (JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }).version;

/**
 * Markers that exist only in the jsdom sheet table (H3). If one of them reaches
 * an emitted renderer chunk, the compile-time gate failed to remove the table —
 * the build must fail rather than ship an invisible, per-render cost.
 */
const TEST_SURFACE_MARKERS = ['Visa records table', 'sheet-accessible-table-wrap'];

function forbidSheetTestSurface(): Plugin {
  return {
    name: 'dks-forbid-sheet-test-surface',
    apply: 'build',
    generateBundle(_options, bundle) {
      const offenders: string[] = [];
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') {
          continue;
        }
        for (const marker of TEST_SURFACE_MARKERS) {
          if (output.code.includes(marker)) {
            offenders.push(`${fileName} contains "${marker}"`);
          }
        }
      }
      if (offenders.length > 0) {
        this.error(
          `The jsdom-only sheet table reached a production bundle (__DKS_TEST_SURFACE__ must be false):\n${offenders.join('\n')}`,
        );
      }

      // The packaged app is loaded from file:// (electron-builder, asar). A
      // chunk request must therefore be RELATIVE to the importing module; a
      // root-absolute "/assets/..." path would 404 only in the installed app,
      // which no browser preview would catch.
      const absoluteImports: string[] = [];
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') {
          continue;
        }
        for (const match of output.code.matchAll(/import\("([^"]+)"\)/g)) {
          if (!match[1].startsWith('./')) {
            absoluteImports.push(`${fileName} imports ${match[1]}`);
          }
        }
      }
      if (absoluteImports.length > 0) {
        this.error(`Dynamic chunks must load relative to the entry for file:// packaging:\n${absoluteImports.join('\n')}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), forbidSheetTestSurface()],
  define: {
    __DKS_VERSION__: JSON.stringify(packageVersion),
    // Test-only markup is removed by the bundler, never enabled at runtime.
    __DKS_TEST_SURFACE__: JSON.stringify(false),
  },
  base: './',
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist-electron/renderer',
    emptyOutDir: true,
    sourcemap: true,
  },
});
