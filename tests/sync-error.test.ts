import { describe, expect, it } from 'vitest';

import { describeSyncError, sanitizeSyncError } from '../src/lib/sync-error';

describe('sanitizeSyncError (Blocker 3)', () => {
  it('redacts a full JWT embedded in error text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig123456';
    const out = sanitizeSyncError(`fetch failed: Bearer ${jwt}`);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain('sig123456');
    expect(out).toContain('[redacted]');
    expect(out).toContain('fetch failed');
  });

  it('redacts apikey= query values and token= values', () => {
    const out = sanitizeSyncError('missing credentials: apikey=abc123456789 in query');
    expect(out).not.toContain('abc123456789');
    expect(out).toContain('missing credentials');
    expect(sanitizeSyncError('token=zzz999888777 invalid')).not.toContain('zzz999888777');
  });

  it('redacts sk-/rk-/pk-/sb- style raw keys', () => {
    expect(sanitizeSyncError('key sk-proj-AbC123456789XYZ rejected')).not.toContain('AbC123456789XYZ');
    expect(sanitizeSyncError('token sb-local-AbC123456789XYZ invalid')).not.toContain('AbC123456789XYZ');
    expect(sanitizeSyncError('denied with pk-test-QwErTy123456')).not.toContain('QwErTy123456');
  });

  it('redacts service_role values but keeps the role wording meaningful', () => {
    expect(sanitizeSyncError('service_role=supersecret123 rejected')).not.toContain('supersecret123');
    const out = sanitizeSyncError('JWT for service role missing');
    expect(out).toContain('service-key');
    expect(out).not.toContain('service role');
    expect(out).toContain('JWT for');
  });

  it('redacts Basic auth payloads and user:pass@host', () => {
    const b64 = Buffer.from('admin:super-secret-1').toString('base64');
    expect(sanitizeSyncError(`Authorization: Basic ${b64}`)).toContain('Basic [redacted]');
    expect(sanitizeSyncError(`Authorization: Basic ${b64}`)).not.toContain(b64);
    const out = sanitizeSyncError('connect to user:passw0rd@db.example.com');
    expect(out).not.toContain('passw0rd');
    expect(out).toContain('db.example.com');
  });

  it('collapses whitespace and caps the result at 400 characters', () => {
    const out = sanitizeSyncError('a b   c\n\n' + 'x'.repeat(900));
    expect(out).toHaveLength(400);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\s{2,}/);
  });

  it('keeps ordinary failure reasons readable', () => {
    const reason = 'new row violates row-level security policy "entries_policy"';
    expect(sanitizeSyncError(reason)).toBe(reason);
  });

  it('yields empty string for empty input; describeSyncError provides the UI fallback', () => {
    expect(sanitizeSyncError('')).toBe('');
    expect(sanitizeSyncError(null)).toBe('');
    expect(sanitizeSyncError(undefined)).toBe('');
    expect(describeSyncError('')).toBe('Unknown sync error');
    expect(describeSyncError('boom')).toBe('boom');
  });
});
