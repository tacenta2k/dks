import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
