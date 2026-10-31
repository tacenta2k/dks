import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Cloud-backup security boundaries.
 *
 * SUPERSEDES `tests/backup-removal.test.ts`, which asserted that DKS contained
 * no backup functionality at all (HANDOFF.md "No backups of any kind"). The
 * owner commissioned encrypted cloud backup as PR1, so that absence rule is
 * retired. What replaces it is stricter where it matters: the boundaries below
 * are the non-negotiables, and each one is checked against real source.
 */

const ROOT = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

const WORKER_FILES = [
  'cloudflare-backup/src/index.ts',
  'cloudflare-backup/src/auth.ts',
  'cloudflare-backup/src/routes.ts',
  'cloudflare-backup/wrangler.toml',
] as const;

const ELECTRON_FILES = [
  'electron/main/backup-service.ts',
  'electron/main/backup-client.ts',
  'electron/main/backup-crypto.ts',
  'electron/main/backup-ipc.ts',
  'electron/main/backup-snapshot.ts',
] as const;

describe('cloud backup — no secrets in the desktop app', () => {
  it('ships no R2 or Cloudflare credential in the Electron sources', () => {
    for (const file of ELECTRON_FILES) {
      const source = read(file);
      expect(source, file).not.toMatch(/account_id/i);
      expect(source, file).not.toMatch(/access_key_id/i);
      expect(source, file).not.toMatch(/secret_access_key/i);
      expect(source, file).not.toMatch(/api_token/i);
      expect(source, file).not.toMatch(/\bR2_[A-Z_]+/);
    }
  });

  it('ships no privileged Supabase credential in the Worker or the desktop app', () => {
    // Comments may discuss the concept; no credential identifier may appear.
    for (const file of [...WORKER_FILES, ...ELECTRON_FILES]) {
      const source = read(file);
      expect(source, file).not.toMatch(/serviceRoleKey|SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE/i);
      expect(source, file).not.toMatch(/sb_secret_[A-Za-z0-9]/);
      expect(source, file).not.toMatch(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\./);
    }
  });

  it('configures the Worker with secrets, never committed vars', () => {
    const toml = read('cloudflare-backup/wrangler.toml');
    expect(toml).toContain('binding = "DKS_BACKUPS"');
    expect(toml).toContain('bucket_name = "dks-backups"');
    expect(toml).not.toMatch(/^SUPABASE_URL\s*=/m);
    expect(toml).not.toMatch(/^SUPABASE_ANON_KEY\s*=/m);
  });

  it('keeps the bucket private', () => {
    const toml = read('cloudflare-backup/wrangler.toml');
    expect(toml).not.toMatch(/r2\.dev/i);
    expect(toml).not.toMatch(/\[\[r2_buckets\]\][\s\S]{0,200}public/i);
    const readme = read('cloudflare-backup/README.md');
    expect(readme.toLowerCase()).toContain('private');
  });
});

describe('cloud backup — no client-trusted authority', () => {
  it('never reads a role or an approval claim out of a request body', () => {
    for (const file of ['cloudflare-backup/src/auth.ts', 'cloudflare-backup/src/routes.ts'] as const) {
      const source = read(file);
      expect(source, file).not.toMatch(/body\s*\.\s*role/);
      expect(source, file).not.toMatch(/\bjson\s*\.\s*role/);
      expect(source, file).not.toMatch(/approved['"]?\s*\]\s*===\s*true/);
    }
  });

  it('verifies the JWT against Supabase JWKS and refuses HS256', () => {
    const auth = read('cloudflare-backup/src/auth.ts');
    expect(auth).toContain('/auth/v1/.well-known/jwks.json');
    expect(auth).toContain("header.alg !== 'RS256'");
    expect(auth).toContain('crypto.subtle.verify');
  });

  it('looks the role up through PostgREST with the caller’s own token', () => {
    const auth = read('cloudflare-backup/src/auth.ts');
    expect(auth).toContain('/rest/v1/profiles?id=eq.');
    expect(auth).toContain('apikey: env.SUPABASE_ANON_KEY');
    expect(auth).toContain('authorization: `Bearer ${token}`');
  });

  it('reuses the existing SECURITY DEFINER Office approval RPC', () => {
    const auth = read('cloudflare-backup/src/auth.ts');
    expect(auth).toContain('/rpc/office_session_is_approved');
    const migration = read('ARENA/sql/office-approval.sql');
    expect(migration).toContain('create or replace function public.office_session_is_approved()');
    expect(migration).toContain('grant execute on function public.office_session_is_approved() to authenticated');
  });

  it('refuses destructive operations until a step-up exists', () => {
    const auth = read('cloudflare-backup/src/auth.ts');
    expect(auth).toContain('STEP_UP_REQUIRED');
    const index = read('cloudflare-backup/src/index.ts');
    const routes = read('cloudflare-backup/src/routes.ts');
    // PR1 registers no delete or replace route: no handler, no method, no verb.
    expect(index + routes).not.toMatch(/handleDelete|handleRestore|handleReplace/);
    expect(index).not.toMatch(/method\s*===?\s*'DELETE'/);
    expect(index).not.toMatch(/method\s*===?\s*'PUT'/);
    // The only deleter in the whole Worker is the retention cron, and it is
    // gated behind a mode the owner must switch on deliberately.
    expect(routes).toContain("mode === 'enforce'");
    expect(read('cloudflare-backup/wrangler.toml')).toContain('RETENTION_MODE = "dry-run"');
  });
});

describe('cloud backup — renderer stays out of Node and off the network', () => {
  const RENDERER_FILES = [
    'src/features/settings/BackupRecoverySection.tsx',
    'src/features/settings/SettingsPage.tsx',
  ] as const;

  it('gives the renderer no Node, crypto, filesystem or Worker access', () => {
    for (const file of RENDERER_FILES) {
      const source = read(file);
      expect(source, file).not.toMatch(/from\s+['"]node:/);
      expect(source, file).not.toMatch(/require\s*\(\s*['"]node:/);
      // No direct import of main-process code either.
      expect(source, file).not.toMatch(/from\s+['"][^'"]*electron\//);
      // And no network call of its own: the Worker is reached only from main.
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/XMLHttpRequest/);
    }
  });

  it('routes every backup action through the validated preload bridge', () => {
    const preload = read('electron/preload/index.ts');
    for (const channel of [
      'dks:backup:get-state',
      'dks:backup:run-now',
      'dks:backup:list',
      'dks:backup:download',
      'dks:backup:test-drill',
      'dks:backup:setup-key',
      'dks:backup:health-check',
    ]) {
      expect(preload, channel).toContain(channel);
    }
    expect(preload).toContain('contextBridge.exposeInMainWorld');
  });

  it('enforces the admin role in the main process, not only in the bridge', () => {
    const ipc = read('electron/main/backup-ipc.ts');
    expect(ipc).toContain('administrator role is required');
    // Any reported session role that is not 'admin' is refused, whatever the
    // renderer claims. Behaviour is covered in tests/backup-ipc.test.ts.
    expect(ipc).toContain("reportedRole !== 'admin'");
    expect(ipc).toContain("clearance === 'office-pending'");
  });
});

describe('cloud backup — keys and snapshots', () => {
  it('never writes a plaintext key and fails when the OS key store is unavailable', () => {
    const crypto = read('electron/main/backup-crypto.ts');
    expect(crypto).toContain('isEncryptionAvailable');
    expect(crypto).toContain('KEY_UNAVAILABLE');

    const service = read('electron/main/backup-service.ts');
    // The only write of the key file goes through the wrapper.
    expect(service).toContain('wrapKeyForStorage(key, this.safeStorage)');
    expect(service).toContain('fs.writeFileSync(this.keyPath, wrapped');
    expect(service).not.toMatch(/writeFileSync\(\s*this\.keyPath\s*,\s*key\b/);
  });

  it('stores only a hash for recovery-key verification', () => {
    const crypto = read('electron/main/backup-crypto.ts');
    expect(crypto).toContain('keyVerificationHash');
    expect(crypto).toContain('timingSafeEqual');
  });

  it('snapshots with the SQLite backup API and strips only the listed tables', () => {
    const store = read('electron/main/sqlite.ts');
    expect(store).toContain('this.database.backup(destination)');
    expect(store).toContain('vacuum_into');
    expect(store).toContain('SNAPSHOT_EXCLUDED_TABLES');
    expect(store).not.toMatch(/copyFileSync/);

    const snapshot = read('electron/main/backup-snapshot.ts');
    expect(snapshot).toContain('integrity_check');
  });

  it('never uses XLSX for a backup', () => {
    for (const file of ELECTRON_FILES) {
      expect(read(file), file).not.toMatch(/xlsx/i);
    }
  });
});
