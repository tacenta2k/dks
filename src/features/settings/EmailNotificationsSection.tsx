import { useEffect, useRef, useState } from 'react';

import {
  EMPTY_EMAIL_PREFS,
  loadEmailNotificationPrefsCached,
  peekCachedEmailNotificationPrefs,
  rememberEmailNotificationPrefs,
  saveEmailNotificationPrefs,
  validateEmailPrefs,
  type EmailNotificationPrefs,
  type EmailPrefsClient,
} from './email-preferences';

/** Admin-only email notification preferences. */
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
  // v0.1.7: a cached value (prefetched by Settings or from an earlier visit)
  // renders the form immediately — no loader, no network wait.
  const [initialCache] = useState(() => (client ? peekCachedEmailNotificationPrefs(client) : null));
  const [prefs, setPrefs] = useState<EmailNotificationPrefs>(() => (
    initialCache?.prefs ?? { ...EMPTY_EMAIL_PREFS }
  ));
  const [recipientsText, setRecipientsText] = useState(() => (
    initialCache?.prefs.expiryRecipients.join('\n') ?? ''
  ));
  const [loaded, setLoaded] = useState(() => !client || initialCache !== null);
  // A failed/timed-out FIRST load shows Retry instead of a form full of
  // defaults that could be saved over the real server preferences.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Once the administrator edits a field, a background refresh never
  // overwrites what they typed.
  const editedRef = useRef(false);

  useEffect(() => {
    if (!client) {
      setLoaded(true);
      return undefined;
    }
    const cached = peekCachedEmailNotificationPrefs(client);
    if (cached?.fresh && loadAttempt === 0) {
      // Fresh enough: no request at all on this mount.
      return undefined;
    }
    let cancelled = false;
    void loadEmailNotificationPrefsCached(client, { force: loadAttempt > 0 || cached !== null })
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.error || !result.data) {
          if (cached) {
            // Stale cache is already on screen; keep it and stay quiet.
            return;
          }
          setLoadError(result.error?.message ?? 'Unable to load email preferences.');
          setLoaded(true);
          return;
        }
        if (!editedRef.current) {
          setPrefs(result.data);
          setRecipientsText(result.data.expiryRecipients.join('\n'));
        }
        setLoadError(null);
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [client, loadAttempt]);

  const editPrefs = (patch: (current: EmailNotificationPrefs) => EmailNotificationPrefs) => {
    editedRef.current = true;
    setPrefs(patch);
  };

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
      rememberEmailNotificationPrefs(client, result.data);
      setPrefs(result.data);
      setRecipientsText(result.data.expiryRecipients.join('\n'));
    }
    editedRef.current = false;
    setError(null);
    setMessage('Email preferences saved.');
  };

  if (!loaded) {
    // Skeleton with roughly the final height, so the form appearing does not
    // push the rest of the Notifications section around.
    return (
      <section
        className="settings-email settings-email--loading"
        role="status"
        aria-busy="true"
        aria-label="Loading email preferences…"
        data-testid="email-prefs-skeleton"
      >
        <h3>Email notifications</h3>
        <span className="settings-skeleton settings-skeleton--toggle" aria-hidden="true" />
        <span className="settings-skeleton settings-skeleton--field" aria-hidden="true" />
        <span className="settings-skeleton settings-skeleton--toggle" aria-hidden="true" />
        <span className="settings-skeleton settings-skeleton--area" aria-hidden="true" />
      </section>
    );
  }

  if (client && loadError) {
    return (
      <section className="settings-email" aria-labelledby="email-notifications-title">
        <h3 id="email-notifications-title">Email notifications</h3>
        <p className="sheet-form__error" role="alert">{loadError}</p>
        <div className="settings-email__actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setLoadError(null);
              setLoaded(false);
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (!client) {
    return (
      <p className="settings-empty" role="status">
        Email notifications are unavailable right now.
      </p>
    );
  }

  return (
    <section className="settings-email" aria-labelledby="email-notifications-title">
      <h3 id="email-notifications-title">Email notifications</h3>

      {error ? <p className="sheet-form__error" role="alert">{error}</p> : null}
      {message ? <p className="settings-alert" role="status">{message}</p> : null}

      <label className="settings-email__toggle" htmlFor="settings-email-approvals-enabled">
        <input
          id="settings-email-approvals-enabled"
          type="checkbox"
          checked={prefs.enabled}
          onChange={(event) => editPrefs((current) => ({ ...current, enabled: event.target.checked }))}
        />
        <span>Email me when an Office sign-in needs approval</span>
      </label>

      <label className="settings-email__field" htmlFor="settings-email-admin-email">
        <span>Administrator email (approval requests)</span>
        <input
          id="settings-email-admin-email"
          type="email"
          value={prefs.adminEmail ?? ''}
          placeholder="admin@example.com"
          onChange={(event) => editPrefs((current) => ({
            ...current,
            adminEmail: event.target.value.trim() || null,
          }))}
        />
      </label>

      <label className="settings-email__toggle" htmlFor="settings-email-digest-enabled">
        <input
          id="settings-email-digest-enabled"
          type="checkbox"
          checked={prefs.expiryDigestEnabled}
          disabled={!prefs.enabled}
          onChange={(event) => editPrefs((current) => ({ ...current, expiryDigestEnabled: event.target.checked }))}
        />
        <span>Send a daily expiry digest</span>
      </label>

      <label className="settings-email__field" htmlFor="settings-email-digest-recipients">
        <span>Digest recipients (one per line)</span>
        <textarea
          id="settings-email-digest-recipients"
          rows={4}
          value={recipientsText}
          disabled={!prefs.enabled || !prefs.expiryDigestEnabled}
          placeholder="admin@example.com\noffice@example.com"
          onChange={(event) => {
            editedRef.current = true;
            setRecipientsText(event.target.value);
          }}
        />
      </label>

      <label className="settings-email__toggle" htmlFor="settings-email-include-full-ids">
        <input
          id="settings-email-include-full-ids"
          type="checkbox"
          checked={prefs.includeFullIds}
          disabled={!prefs.enabled || !prefs.expiryDigestEnabled}
          onChange={(event) => editPrefs((current) => ({ ...current, includeFullIds: event.target.checked }))}
        />
        <span>Include full Passport / Civil ID values in the emailed PDF</span>
      </label>

      <p className="settings-help settings-help--warning" role="note">
        Warning: this sends sensitive passport and Civil ID numbers in the
        daily PDF. It is on by default because that PDF goes only to the
        administrator mailbox, who may need to call the customer from the email
        alone. Turn it off to mask them.
      </p>

      <p className="settings-help" role="note">
        Local alerts keep working even if email cannot be sent.
      </p>

      <div className="settings-email__actions">
        <button type="button" className="button button--primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save email preferences'}
        </button>
      </div>
    </section>
  );
}
