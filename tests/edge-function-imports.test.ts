import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const edgeFunctionsDir = resolve(__dirname, '../supabase/edge-functions');

/**
 * Deno Edge Functions require an explicit file extension on every relative
 * import; TypeScript under `src/` may omit them. Without it the bundler fails
 * with `Module not found ... Maybe add a '.ts' extension`, which is exactly
 * what broke `supabase functions deploy send-email`. This guard makes the
 * convention enforceable so a future edit cannot reintroduce it.
 */
describe('Edge Function import specifiers', () => {
  it('puts an explicit extension on every relative import', () => {
    const files = walk(edgeFunctionsDir);
    expect(files.length).toBeGreaterThan(0);

    const specifiers: Array<{ file: string; specifier: string }> = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(new RegExp(IMPORT_SPECIFIER.source, 'g'))) {
        specifiers.push({ file, specifier: match[2] });
      }
    }

    const relative = specifiers.filter(({ specifier }) => RELATIVE_SPECIFIER.test(specifier));
    const withoutExtension = relative
      .filter(({ specifier }) => !KNOWN_EXTENSION.test(specifier))
      .map(({ file, specifier }) => `${file}: '${specifier}'`);

    expect(withoutExtension).toEqual([]);

    // Guards against the scan silently matching nothing.
    expect(relative.length).toBeGreaterThan(0);
    expect(specifiers.filter(({ specifier }) => specifier.startsWith('npm:')).length).toBeGreaterThan(0);
  });

  it('resolves every relative import to a real file', () => {
    const files = walk(edgeFunctionsDir);

    const unresolved: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(new RegExp(IMPORT_SPECIFIER.source, 'g'))) {
        const specifier = match[2];
        if (!RELATIVE_SPECIFIER.test(specifier)) {
          continue;
        }
        if (!existsSync(resolve(dirname(file), specifier))) {
          unresolved.push(`${file}: '${specifier}'`);
        }
      }
    }

    expect(unresolved).toEqual([]);
  });

  it('leaves Deno npm: specifiers alone', () => {
    const sendEmail = readFileSync(join(edgeFunctionsDir, 'send-email/index.ts'), 'utf8');
    expect(sendEmail).toContain('npm:jspdf');
    // And the guard must not treat it as a relative import needing an extension.
    expect('npm:jspdf').not.toMatch(RELATIVE_SPECIFIER);
  });
});

function walk(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|js)$/.test(full)) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Remove line comments and block comments while preserving the contents of
 * string and template literals, so a commented-out import cannot trip the
 * guard.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      out += ' ';
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
      }
      out += source[i] ?? '';
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

const IMPORT_SPECIFIER = /\b(?:from|import)\b\s*(?:\(\s*)?(['"])([^'"]+)\1/g;
const RELATIVE_SPECIFIER = /^(\.{1,2}\/)/;
const KNOWN_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs|json)$/;
