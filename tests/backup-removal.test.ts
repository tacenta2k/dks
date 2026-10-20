import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = process.cwd();

const ownedSourceFiles = [
  'README.md',
  'electron/main/index.ts',
  'electron/main/local-ipc.ts',
  'electron/main/sqlite.ts',
  'electron/preload/index.ts',
  'src/features/settings/SettingsPage.tsx',
  'src/features/settings/settings.css',
  'src/lib/types.ts',
  'src/renderer/components/AppShell.tsx',
];

describe('backup removal', () => {
  it('removes the backup module and backup references from owned source surfaces', () => {
    expect(existsSync(resolve(sourceRoot, 'electron/main/backup.ts'))).toBe(false);

    for (const relativePath of ownedSourceFiles) {
      const source = readFileSync(resolve(sourceRoot, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/backup/i);
    }
  });
});
