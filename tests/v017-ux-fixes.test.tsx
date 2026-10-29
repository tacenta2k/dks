import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { AuthService, type AuthClientLike } from '../src/features/auth/auth-service';
import { App } from '../src/renderer/App';
import { AuthSplash } from '../src/renderer/components/AuthSplash';
import { SettingsPage } from '../src/features/settings/SettingsPage';
import { EmailNotificationsSection } from '../src/features/settings/EmailNotificationsSection';
import {
  clearEmailNotificationPrefsCache,
  loadEmailNotificationPrefs,
  type EmailPrefsClient,
} from '../src/features/settings/email-preferences';

const readStyle = (...parts: string[]) => readFileSync(resolve(__dirname, '..', ...parts), 'utf8');

/** Deferred auth client: `getSession` stays pending until the test resolves it. */
function deferredAuthClient() {
  let resolveSession: (value: { data: { session: null }; error: null }) => void = () => undefined;
  const pending = new Promise<{ data: { session: null }; error: null }>((settle) => {
    resolveSession = settle;
  });
  const auth = {
    signInWithPassword: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    getSession: vi.fn(() => pending),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  };
  const client: AuthClientLike = {
    auth,
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })),
      })),
    })),
  };
  return {
    client,
    resolveSession: (value: { data: { session: null }; error: null }) => resolveSession(value),
  };
}

describe('v0.1.7 — startup renders a splash, never the sign-in form', () => {
  it('splash is inert: no inputs, no sign-in headings, announced politely', () => {
    render(<AuthSplash />);

    const card = document.querySelector('.auth-splash__card');
    expect(card).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Restoring your session');
    expect(screen.getByRole('heading', { name: 'DKS' })).toBeInTheDocument();

    // Nothing a keystroke or a tab stop could land in.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in to DKS' })).not.toBeInTheDocument();
  });

  it('never paints AuthScreen while the persisted session is still resolving', async () => {
    const { client, resolveSession } = deferredAuthClient();
    const service = new AuthService(client);

    render(<App authService={service} />);

    // Restoration is in flight.
    expect(document.querySelector('.auth-splash__card')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sign in to DKS' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();

    resolveSession({ data: { session: null }, error: null });

    // Only AFTER the restore settles with no session does the form appear.
    expect(await screen.findByRole('heading', { name: 'Sign in to DKS' })).toBeInTheDocument();
    expect(document.querySelector('.auth-splash__card')).toBeNull();
  });
});

describe('v0.1.7 — the save banner is a floating overlay driven only by user edits', () => {
  it('renders the banner inside the fixed overlay host, outside the settings grid', async () => {
    const onSettingsChange = vi.fn().mockResolvedValue(undefined);
    render(<SettingsPage role="admin" onSettingsChange={onSettingsChange} />);

    fireEvent.change(screen.getByLabelText('Green status color'), { target: { value: '#008000' } });
    const message = await screen.findByText('Settings saved to the workspace.');

    const host = message.closest('.settings-banner-host');
    expect(host).not.toBeNull();
    // The host is a sibling of the page content, not a child of it: a banner
    // appearing/disappearing cannot move anything else.
    expect(host?.parentElement?.querySelector('.settings-content')).not.toBe(host);
    expect(message.closest('.settings-alert--toast')).not.toBeNull();
  });

  it('does not save or report anything when settings arrive from a background refresh', async () => {
    const onSettingsChange = vi.fn().mockResolvedValue(undefined);
    const base = {
      thresholds: {
        colors: { Valid: '#16a34a', Warning: '#eab308', Urgent: '#f97316', Today: '#dc2626', Expired: '#7f1d1d' },
      },
    } as never;

    const { rerender } = render(
      <SettingsPage role="admin" settings={base} onSettingsChange={onSettingsChange} />,
    );
    onSettingsChange.mockClear();

    // A shell sync / local-cache read pushes new settings into the page.
    rerender(
      <SettingsPage
        role="admin"
        settings={{
          ...(base as Record<string, unknown>),
          dailySummaryEnabled: false,
        } as never}
        onSettingsChange={onSettingsChange}
      />,
    );

    // Give the auto-save effect time to (not) fire.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/Settings saved/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cloud sync failed/i)).not.toBeInTheDocument();
  });

  it('positions the toast out of flow so nothing shifts', () => {
    const css = readStyle('src', 'features', 'settings', 'settings.css');
    const host = css.slice(css.indexOf('.settings-banner-host'));
    expect(host).toMatch(/position:\s*fixed/);
    expect(host).toMatch(/pointer-events:\s*none/);
    expect(host).toMatch(/z-index:\s*\d+/);
    expect(css).toMatch(/\.settings-alert--toast\s*\{[^}]*pointer-events:\s*auto/);
    // The 900px layout rule for the alert options must survive.
    expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.settings-alert-options/);
  });
});

describe('v0.1.7 — Settings → Notifications loads asynchronously', () => {
  function makePrefsClient(value: Record<string, unknown> | null, delay = 0) {
    const maybeSingle = vi.fn(() => new Promise((settle) => {
      setTimeout(() => settle({ data: value === null ? null : { key: 'email_notifications', value }, error: null }), delay);
    }));
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
      })),
    } as unknown as EmailPrefsClient;
    return { client, maybeSingle };
  }

  it('shows a skeleton while loading and never a blocking error', async () => {
    const { client } = makePrefsClient({ expiry_recipients: ['ops@example.com'], include_full_ids: true }, 50);
    clearEmailNotificationPrefsCache(client);

    const { container } = render(<EmailNotificationsSection client={client} />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading email preferences');
    expect(container.querySelectorAll('.settings-email__skeleton-row').length).toBe(3);
    // The section itself is marked busy, and it is a section (layout stays put).
    expect(container.querySelector('.settings-email--loading')).toHaveAttribute('aria-busy', 'true');

    await waitFor(() => expect(screen.queryByText(/Loading email preferences/i)).not.toBeInTheDocument());
    expect(screen.getByLabelText('Digest recipients (one per line)')).toHaveValue('ops@example.com');
  });

  it('issues one request and reuses the cached prefs when the tab is reopened', async () => {
    const { client, maybeSingle } = makePrefsClient({ expiry_recipients: ['ops@example.com'], include_full_ids: true }, 10);
    clearEmailNotificationPrefsCache(client);

    const first = render(<EmailNotificationsSection client={client} />);
    await waitFor(() => expect(screen.queryByText(/Loading email preferences/i)).not.toBeInTheDocument());
    first.unmount();

    render(<EmailNotificationsSection client={client} />);
    // Cached: the form is there on the very first paint, no spinner, no request.
    expect(screen.getByLabelText('Digest recipients (one per line)')).toHaveValue('ops@example.com');
    expect(screen.queryByText(/Loading email preferences/i)).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request between two simultaneous opens', async () => {
    const { client, maybeSingle } = makePrefsClient(null, 20);
    clearEmailNotificationPrefsCache(client);

    const [a, b] = await Promise.all([
      loadEmailNotificationPrefs(client),
      loadEmailNotificationPrefs(client),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('turns a stalled request into a retryable error instead of hanging', async () => {
    const maybeSingle = vi.fn(() => new Promise(() => undefined)); // never settles
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
      })),
    } as unknown as EmailPrefsClient;

    const result = await loadEmailNotificationPrefs(client, { timeoutMs: 40 });
    expect(result.error?.message).toMatch(/Unable to load email preferences/i);
  });
});

describe('v0.1.7 — the shell pins the sidebar and scrolls only the content', () => {
  it('keeps the sidebar at full height and lets only the body scroll', () => {
    const css = readStyle('src', 'renderer', 'styles.css');

    const shell = css.match(/\.app-shell\s*\{[^}]*\}/)?.[0] ?? '';
    expect(shell).toMatch(/height:\s*100vh/);
    expect(shell).toMatch(/overflow:\s*hidden/);

    const sidebar = css.match(/\n\.sidebar\s*\{[^}]*\}/)?.[0] ?? '';
    expect(sidebar).toMatch(/height:\s*100vh/);
    // The rail never scrolls, so the logo cannot scroll away; only the nav list
    // scrolls when the window is shorter than the navigation.
    expect(sidebar).toMatch(/overflow:\s*hidden/);
    const nav = css.match(/\n\.sidebar__nav\s*\{[^}]*\}/)?.[0] ?? '';
    expect(nav).toMatch(/overflow-y:\s*auto/);
    expect(nav).toMatch(/min-height:\s*0/);

    const body = css.match(/\.app-shell__body\s*\{[^}]*\}/)?.[0] ?? '';
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/min-height:\s*0/);

    // Narrow screens go back to normal document flow (no double scrollbars).
    const narrow = css.slice(css.indexOf('@media (max-width: 720px)'));
    expect(narrow).toMatch(/\.app-shell\s*\{[^}]*display:\s*block/);
    expect(narrow).toMatch(/\.sidebar\s*\{[^}]*height:\s*auto/);
    // ...and the nav must stop being an inner scroll area there.
    expect(narrow).toMatch(/\.sidebar__nav\s*\{[^}]*overflow:\s*visible/);
    expect(narrow).toMatch(/\.app-shell__body\s*\{[^}]*overflow:\s*visible/);
  });
});
