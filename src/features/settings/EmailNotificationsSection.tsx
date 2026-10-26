import { useEffect, useState } from 'react';

import {
  EMPTY_EMAIL_PREFS,
  loadEmailNotificationPrefs,
  saveEmailNotificationPrefs,
  validateEmailPrefs,
  type EmailNotificationPrefs,
  type EmailPrefsClient,
} from './email-preferences';

/**
 * Admin-only email notification settings (Settings → Notifications).
 *
 * The preferences live in the SUPABASE settings table — they configure
 * server-side email. The Resend API key is a Supabase Edge Function secret
 * and NEVER appears here; fields are limited to who gets what.
 *
 * Privacy + free-tier notes are shown inline so the operator sees them once:
 *  - the Resend onboarding sender is test-only (see deploy docs);
 *  - digest bodies carry row labels + expiry only (no passport/Civil ID);
 *  - failure never blocks sign-in or local saves.
 */
export interface EmailNotificationsSectionProps {
  client: EmailPrefsClient | null;
}

function normalizeRecipients(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[\n,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
    .filter((item) => (seen.has(item) ? false : (seen.add(item), true)));
}

export function EmailNotificationsSection({ client }: EmailNotificationsSectionProps) {
  const [prefs, setPrefs] = useState<EmailNotificationPrefs>({ ...EMPTY_EMAIL_PREFS });
  const [recipientsText, setRecipientsText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) {
      setLoaded(true);
      return undefined;
    }
    let cancelled = false;
    void loadEmailNotificationPrefs(client).then((result) => {
      if (cancelled || result.error && !result.data) {
        if (!cancelled) {
          setError(result.error?.message ?? 'Unable to load email preferences.');
          setLoaded(true);
        }
        return;
      }
      if (!cancelled) {
        const prefsResult = result.data ?? { ...EMPTY_EMAIL_PREFS };
        setPrefs(prefsResult);
        setRecipientsText(prefsResult.expiryRecipients.join('\n'));
        setError(result.error ? result.error.message : null);
        setLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [client]);

  const save = async (): Promise<void> => {
    if (!client || busy) {
      return;
    }
    const recipients = normalizeRecipients(recipientsText);
    const next: EmailNotificationPrefs = {
      ...prefs,
      expiryRecipients: recipients,
    };
    const problem = validateEmailPrefs(next);
    if (problem) {
      setError(problem);
      setMessage(null);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await saveEmailNotificationPrefs(client, next);
    setBusy(false);
    if (result.error) {
      setError(result.error.message);
      setMessage(null);
      return;
    }
    if (result.data) {
      setPrefs(result.data);
      setRecipientsText(result.data.expiryRecipients.join('\n'));
    }
    setError(null);
    setMessage('Email preferences saved.');
  };

  if (!loaded) {
    return <p className="settings-empty" role="status">Loading email preferences…</p>;
  }

  if (!client) {
    return (
      <p className="settings-empty" role="status">
        Email notifications require Supabase connection (offline configuration is local-only).
      </p>
    );
  }

  return (
    <section className="settings-email" aria-label="Email notifications">
      <h3 id="email-notifications-title">Email notifications</h3>
      <p className="settings-help">
        Server-side email via a private Edge Function — the Resend API key lives in Supabase
        Edge Function secrets only, never in this app. Email failing never blocks sign-in,
        approvals, or local saves.
      </p>

      {error ? <p className="sheet-form__error" role="alert">{error}</p> : null}
      {message ? <p className="settings-alert" role="status">{message}</p> : null}

      <label className="settings-email__toggle">
        <input
          type="checkbox"
          checked={prefs.enabled}
          onChange={(event) => setPrefs((current) => ({ ...current, enabled: event.target.checked }))}
        />
        <span>Email me when an Office sign-in needs approval</span>
      </label>

      <label>
        Administrator email (approval requests)
        <input
          type="email"
          value={prefs.adminEmail ?? ''}
          placeholder="admin@example.com"
          onChange={(event) => setPrefs((current) => ({
            ...current,
            adminEmail: event.target.value.trim() || null,
          }))}
        />
      </label>

      <label className="settings-email__toggle">
        <input
          type="checkbox"
          checked={prefs.expiryDigestEnabled}
          disabled={!prefs.enabled}
          onChange={(event) => setPrefs((current) => ({ ...current, expiryDigestEnabled: event.target.checked }))}
        />
        <span>Send me the daily expiry digest (at most one per day)</span>
      </label>

      <label>
        Digest recipients (one per line)
        <textarea
          rows={4}
          value={recipientsText}
          disabled={!prefs.enabled || !prefs.expiryDigestEnabled}
          placeholder="admin@example.com\noffice@example.com"
          onChange={(event) => setRecipientsText(event.target.value)}
        />
      </label>

      <p className="settings-help" role="note">
        Email is best-effort and optional: local alerts keep working even when configured email
        is unreachable. The onboarding Resend sender is test-only until a domain is verified.
      </p>

      <div>
        <button type="button" className="button button--primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save email preferences'}
        </button>
      </div>
    </section>
  );
}
