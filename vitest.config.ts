import { readFileSync } from 'node:fs';

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const packageVersion = (JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }).version;

export default defineConfig({
  plugins: [react()],
  define: {
    __DKS_VERSION__: JSON.stringify(packageVersion),
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
    css: true,
    // jsdom + AG Grid + jsPDF integration tests measure 1–4s on a fast
    // machine; the vitest default of 5s turns that into flaky timeouts on
    // slower machines. Timeouts are ceilings, not waits — fast runs are
    // unaffected and assertions stay strict.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
