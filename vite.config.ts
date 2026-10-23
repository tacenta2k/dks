import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const packageVersion = (JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }).version;

export default defineConfig({
  plugins: [react()],
  define: {
    __DKS_VERSION__: JSON.stringify(packageVersion),
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
