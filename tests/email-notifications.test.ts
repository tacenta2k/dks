import { describe, expect, it } from 'vitest';

import {
  buildExpiryDigestEmail,
  buildOfficeApprovalEmail,
  dedupeKey,
  isValidEmail,
  recipientsFrom,
  redactEntryRecord,
} from '../supabase/edge-functions/_shared/email';
import {
  EMAIL_PREFS_SETTINGS_KEY,
  emailPrefsToRecord,
  parseEmailPrefs,
  saveEmailNotificationPrefs,
  loadEmailNotificationPrefs,
  validateEmailPrefs,
  type EmailPrefsClient,
} from '../src/features/settings/email-preferences';

describe('email helpers (server-side edge function)', () => {
  it('validates only plain email addresses (no display-name vectors)', () => {
    expect(isValidEmail('admin@example.com')).toBe(true);
    expect(isValidEmail('Name <admin@example.com>')).toBe(false);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
  });

  it('parses comma-separated recipient lists and drops malformed entries', () => {
    expect(recipientsFrom('admin@example.com, office@example.com, not-an-email')).toEqual([
      'admin@example.com',
      'office@example.com',
    ]);
    expect(recipientsFrom(['a@b.co', 'a@b.co', 'not-an-email'])).toEqual(['a@b.co']);
    expect(recipientsFrom(null)).toEqual([]);
    expect(recipientsFrom(42)).toEqual([]);
  });

  it('approval email carries NO credentials/approval link/session data', () => {
    const email = buildOfficeApprovalEmail('2026-10-24T10:00:00Z');
    expect(email.to).toEqual([]); // recipient resolved server-side only
    expect(email.text.toLowerCase()).not.toContain('token');
    expect(email.text.toLowerCase()).not.toContain('password');
    expect(email.text.toLowerCase()).not.toContain('session');
    expect(email.text.toLowerCase()).toContain('open dks to review an office sign-in request');
    expect(email.subject.toLowerCase()).toContain('office');
  });

  it('digest stays batched, and never exposes passport/civil ids', () => {
    const email = buildExpiryDigestEmail([
      { label: 'John Doe', expiry: '2026-11-01', daysLeft: 7 },
      { label: 'Jane Roe', expiry: '2026-11-21', daysLeft: 27 },
    ]);
    expect(email.subject.toLowerCase()).toContain('expiry digest');
    expect(email.text).toContain('John Doe');
    expect(email.text).toContain('Jane Roe');
    expect(email.text.toLowerCase()).not.toContain('passport');
    expect(email.text.toLowerCase()).not.toContain('civil');
    expect(email.html).toContain('<ul>');
  });

  it('redacts sensitive record keys before digest construction' + '', () => {
    const record = {
      full_name: 'Jane Roe',
      passport: 'A01234',
      civil_id: '0099xyz',
      'Civil ID': '0099xyz',
      visa_no: '777',
      notes: 'office manager',
      visa_expiry: '2026-11-01',
    };
    const entry = redactEntryRecord(record, { labelKeys: ['full_name'], expiryKey: 'visa_expiry' })!;
    expect(entry.label).toBe('Jane Roe');
    expect(entry.expiry).toBe('2026-11-01');
    // A record with ONLY sensitive identifiers must NOT produce a label.
    const noLabel = redactEntryRecord({ passport: 'A0', civil_id: '1' }, { labelKeys: [], expiryKey: 'visa_expiry' });
    expect(noLabel).toBeNull();
  });

  it('dedupe keys identify one email per kind/day/target', () => {
    expect(dedupeKey('office_signin_request', ['req-1'])).toBe('office_signin_request:req-1');
    expect(dedupeKey('expiry_digest', ['admin@example.com', '2026-10-24']))
      .toBe('expiry_digest:admin@example.com:2026-10-24');
  });
});

describe('email preferences persistence contract', () => {
  function fakeClient(row: Record<string, unknown> | null, saved: unknown[] = []): EmailPrefsClient & { saved: unknown[] } {
    return {
      saved,
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: row, error: null }),
          }),
        }),
        upsert: async (values: readonly Record<string, unknown>[]) => {
          saved.push(...values);
          return { data: [...values], error: null };
        },
      }),
    };
  }

  it('round-trips prefs through the settings row contract', async () => {
    const saved: unknown[] = [];
    const client = fakeClient(null, saved);
    const result = await saveEmailNotificationPrefs(client, {
      enabled: true,
      adminEmail: 'Admin@Example.COM ',
      expiryDigestEnabled: true,
      expiryRecipients: ['office@example.com'],
      includeFullIds: false,
    });
    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      enabled: true,
      adminEmail: 'admin@example.com',
      expiryDigestEnabled: true,
      expiryRecipients: ['office@example.com'],
      includeFullIds: false,
    });
    expect(saved).toEqual([{ key: EMAIL_PREFS_SETTINGS_KEY, value: emailPrefsToRecord(result.data!) }]);
  });

  it('loads defaults when no row exists (email fully off)', async () => {
    const client = fakeClient(null);
    const result = await loadEmailNotificationPrefs(client);
    expect(result.data).toEqual({
      enabled: false,
      adminEmail: null,
      expiryDigestEnabled: false,
      expiryRecipients: [],
      includeFullIds: false,
    });
    expect(result.error).toBeNull();
  });

  it('parses persisted rows with the snake_case server shape', () => {
    const parsed = parseEmailPrefs({
      enabled: true,
      admin_email: 'admin@example.com',
      expiry_digest_enabled: true,
      expiry_recipients: ['a@b.co', 'bad-email'],
    });
    expect(parsed.adminEmail).toBe('admin@example.com');
    expect(parsed.expiryRecipients).toEqual(['a@b.co']); // bad entry filtered
  });

  it('blocks saving an ON config without a valid admin email (free-tier trap guard)', () => {
    expect(validateEmailPrefs({
      enabled: true,
      adminEmail: null,
      expiryDigestEnabled: false,
      expiryRecipients: [],
      includeFullIds: false,
    })).toMatch(/administrator email/i);

    expect(validateEmailPrefs({
      enabled: true,
      adminEmail: 'admin@example.com',
      expiryDigestEnabled: true,
      expiryRecipients: [],
      includeFullIds: false,
    })).toMatch(/digest recipient/i);

    expect(validateEmailPrefs({
      enabled: false,
      adminEmail: null,
      expiryDigestEnabled: false,
      expiryRecipients: [],
      includeFullIds: false,
    })).toBeNull();
  });
});
