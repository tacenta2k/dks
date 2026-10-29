import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { SettingsPage } from '../src/features/settings/SettingsPage';
import {
  loadEmailNotificationPrefsCached,
  peekCachedEmailNotificationPrefs,
  prefetchEmailNotificationPrefs,
} from '../src/features/settings/email-preferences';

const shellCss = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
const settingsCss = readFileSync(resolve(__dirname, '../src/features/settings/settings.css'), 'utf8');
const sheetCss = readFileSync(resolve(__dirname, '../src/features/sheet/sheet.css'), 'utf8');

function ruleBody(css: string, selector: string): string {
  const index = css.indexOf(selector);
  expect(index, `missing CSS rule ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', index);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

const nav = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }));

// ---------------------------------------------------------------------------
// Issue 3 — "Settings saved" banner spam and layout shift
// ---------------------------------------------------------------------------

describe('settings save banner only follows explicit user edits (v0.1.7)', () => {
  it('does not save or show a banner when background settings arrive', async () => {
    const onSettingsChange = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <SettingsPage role="admin" settings={{ dailySummaryTime: '09:00' }} onSettingsChange={onSettingsChange} />,
    );

    // A sync / remote fetch hands the page new workspace settings twice.
    rerender(<SettingsPage role="admin" settings={{ dailySummaryTime: '10:30' }} onSettingsChange={onSettingsChange} />);
    rerender(<SettingsPage role="admin" settings={{ dailySummaryTime: '11:45', theme: 'dark' }} onSettingsChange={onSettingsChange} />);
    await act(async () => { await Promise.resolve(); });

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/Settings saved/i)).not.toBeInTheDocument();
    // The background value is still reflected in the form.
    nav('Notifications');
    expect(screen.getByLabelText('Daily summary time')).toHaveValue('11:45');
  });

  it('does not save when the parent re-renders with a new callback identity', async () => {
    const calls: unknown[] = [];
    const makeHandler = () => async (value: unknown) => { calls.push(value); };
    const { rerender } = render(<SettingsPage role="admin" onSettingsChange={makeHandler()} />);

    // App re-renders on every sync tick / updater progress event; its save
    // callback is a fresh function each time.
    for (let i = 0; i < 5; i += 1) {
      rerender(<SettingsPage role="admin" onSettingsChange={makeHandler()} />);
    }
    nav('About & updates');
    rerender(<SettingsPage role="admin" onSettingsChange={makeHandler()} />);
    await act(async () => { await Promise.resolve(); });

    expect(calls).toHaveLength(0);
    expect(screen.queryByText(/Settings saved/i)).not.toBeInTheDocument();
  });

  it('does not save when the column list loads and fills the primary expiry id', async () => {
    const onSettingsChange = vi.fn().mockResolvedValue(undefined);
    const repository = {
      getColumns: vi.fn(async () => [
        { id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', isPrimaryExpiry: true },
      ]),
    };
    render(<SettingsPage role="admin" repository={repository as never} onSettingsChange={onSettingsChange} />);

    await waitFor(() => expect(repository.getColumns).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/Settings saved/i)).not.toBeInTheDocument();
  });

  it('saves exactly once per user change and shows the toast', async () => {
    const onSettingsChange = vi.fn().mockResolvedValue(undefined);
    render(<SettingsPage role="admin" onSettingsChange={onSettingsChange} />);

    fireEvent.change(screen.getByLabelText('Green status color'), { target: { value: '#008000' } });

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange.mock.calls[0][0]).toMatchObject({ thresholds: { colors: { Valid: '#008000' } } });
    const toast = await screen.findByText('Settings saved to the workspace.');
    expect(toast.closest('[data-testid="settings-save-toast"]')).toHaveClass('settings-alert--toast');
  });

  it('renders the save feedback as a fixed overlay that cannot shift the layout', () => {
    const toast = ruleBody(settingsCss, '.settings-alert--toast {');
    expect(toast).toMatch(/position:\s*fixed/);
    expect(toast).toMatch(/z-index:/);
  });
});

// ---------------------------------------------------------------------------
// Issue 4 — Notifications tab loads fast
// ---------------------------------------------------------------------------

function emailClient(options: {
  row?: Record<string, unknown> | null;
  hang?: boolean;
} = {}) {
  const maybeSingle = vi.fn(() => (options.hang
    ? new Promise(() => undefined)
    : Promise.resolve({
      data: options.row === undefined
        ? {
          key: 'email_notifications',
          value: {
            enabled: true,
            admin_email: 'admin@example.com',
            expiry_digest_enabled: false,
            expiry_recipients: [],
          },
        }
        : options.row,
      error: null,
    })));
  const client = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
      upsert: vi.fn(async () => ({ data: [], error: null })),
    })),
  };
  return { client, maybeSingle };
}

describe('email preferences loading (v0.1.7)', () => {
  it('shares one in-flight request and serves later loads from the cache', async () => {
    const { client, maybeSingle } = emailClient();

    const [a, b] = await Promise.all([
      loadEmailNotificationPrefsCached(client as never),
      loadEmailNotificationPrefsCached(client as never),
    ]);
    await loadEmailNotificationPrefsCached(client as never);

    expect(maybeSingle).toHaveBeenCalledTimes(1);
    expect(a.data?.adminEmail).toBe('admin@example.com');
    expect(b.data?.adminEmail).toBe('admin@example.com');
    expect(peekCachedEmailNotificationPrefs(client as never)?.fresh).toBe(true);
  });

  it('times out instead of hanging forever', async () => {
    const { client } = emailClient({ hang: true });

    const result = await loadEmailNotificationPrefsCached(client as never, { timeoutMs: 20 });

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe('EMAIL_PREFS_LOAD_TIMEOUT');
  });

  it('Settings prefetches on open so the Notifications tab renders without a second request', async () => {
    const { client, maybeSingle } = emailClient();
    render(<SettingsPage role="admin" emailPrefsClient={client as never} />);

    await waitFor(() => expect(peekCachedEmailNotificationPrefs(client as never)).not.toBeNull());
    nav('Notifications');

    // Rendered synchronously from the cache — no skeleton, no extra fetch.
    expect(screen.queryByTestId('email-prefs-skeleton')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Administrator email (approval requests)')).toHaveValue('admin@example.com');
    expect(maybeSingle).toHaveBeenCalledTimes(1);

    // Leaving and re-entering the tab is instant too.
    nav('Workspace');
    nav('Notifications');
    expect(screen.getByLabelText('Administrator email (approval requests)')).toHaveValue('admin@example.com');
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('shows a skeleton (not a blocking page) while loading, keeping the rest of the section usable', () => {
    const { client } = emailClient({ hang: true });
    render(<SettingsPage role="admin" emailPrefsClient={client as never} />);
    nav('Notifications');

    expect(screen.getByTestId('email-prefs-skeleton')).toHaveAttribute('aria-busy', 'true');
    // The local notification controls are already interactive.
    expect(screen.getByLabelText('Daily summary')).toBeEnabled();
    expect(screen.getByLabelText('Notification day 1')).toBeEnabled();
  });

  it('offers Retry after a failed first load instead of a form of defaults', async () => {
    let fail = true;
    const maybeSingle = vi.fn(async () => (fail
      ? { data: null, error: { message: 'connection reset' } }
      : { data: { key: 'email_notifications', value: { enabled: true, admin_email: 'admin@example.com' } }, error: null }));
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
        upsert: vi.fn(async () => ({ data: [], error: null })),
      })),
    };
    render(<SettingsPage role="admin" emailPrefsClient={client as never} />);
    nav('Notifications');

    expect(await screen.findByText('connection reset')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save email preferences' })).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Administrator email (approval requests)')).toHaveValue('admin@example.com');
  });

  it('prefetch is a no-op without a client', () => {
    expect(() => prefetchEmailNotificationPrefs(null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Issue 5 — sidebar stays pinned; only the page container scrolls
// ---------------------------------------------------------------------------

describe('pinned shell layout (v0.1.7)', () => {
  it('locks the shell to the viewport so the document never scrolls the sidebar away', () => {
    const shell = ruleBody(shellCss, '.app-shell {');
    expect(shell).toMatch(/height:\s*100vh/);
    expect(shell).toMatch(/overflow:\s*hidden/);
  });

  it('pins the sidebar at full height', () => {
    const sidebar = ruleBody(shellCss, '.sidebar {');
    expect(sidebar).toMatch(/position:\s*sticky/);
    expect(sidebar).toMatch(/height:\s*100%/);
    expect(sidebar).toMatch(/top:\s*0/);
  });

  it('makes only the main page container scroll vertically', () => {
    const body = ruleBody(shellCss, '.app-shell__body {');
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/flex-direction:\s*column/);

    const content = ruleBody(shellCss, '.content {');
    expect(content).toMatch(/overflow-y:\s*auto/);
    expect(content).toMatch(/min-height:\s*0/);
    // Ordinary pages stay a centred 1280px column.
    expect(content).toContain('1280px');

    const topBar = ruleBody(shellCss, '.top-bar {');
    expect(topBar).toMatch(/flex:\s*0 0 auto/);
  });

  it('keeps the sheet filling the body with the grid scrolling internally', () => {
    const sheet = ruleBody(sheetCss, '.content.content--sheet {');
    expect(sheet).toMatch(/flex:\s*1 1 auto/);
    expect(sheet).toMatch(/overflow:\s*hidden/);
  });
});
