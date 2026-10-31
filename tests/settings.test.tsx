import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../src/renderer/components/AppShell';
import {
  SAVE_BANNER_VISIBLE_MS,
  SettingsPage,
  visibleSettingsSections,
} from '../src/features/settings/SettingsPage';

// FIXES_UI §9.1: Settings now uses an inner navigation (Expiry rules /
// Notifications / Workspace / About & updates) with one section at a time, so
// the tests navigate to the relevant section before asserting its controls.
const nav = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }));

describe('settings page', () => {
  it('denies office users without rendering protected settings controls', () => {
    render(<SettingsPage role="office" />);

    expect(screen.getByRole('alert')).toHaveTextContent(/administrators only/i);
    expect(screen.queryByLabelText('Green status color')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Backup Now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out all office sessions' })).not.toBeInTheDocument();
    // Office is denied the whole page, so it can never reach a backup control.
    expect(screen.queryByRole('button', { name: 'Backup & recovery' })).not.toBeInTheDocument();
  });

  it('keeps the Backup & recovery tab out of the nav for any non-admin role', () => {
    // Defence in depth: if a future role is ever allowed into Settings without
    // being an admin, the backup tab must still not appear for it.
    expect(visibleSettingsSections('admin').map((section) => section.id)).toEqual([
      'expiry', 'notifications', 'workspace', 'backup', 'about',
    ]);
    for (const role of ['office', '', null, undefined]) {
      expect(visibleSettingsSections(role).map((section) => section.id)).toEqual([
        'expiry', 'notifications', 'workspace', 'about',
      ]);
    }
  });

  it('renders injectable admin settings and emits local-first changes and actions', () => {
    const onSettingsChange = vi.fn();
    const onCheckForUpdates = vi.fn();

    render(
      <SettingsPage
        role="admin"
        columns={[
          {
            id: 'visa_expiry',
            name: 'Visa Expiry',
            type: 'date_expiry',
            isPrimaryExpiry: true,
          },
        ]}
        appVersion="1.2.3"
        onSettingsChange={onSettingsChange}
        onCheckForUpdates={onCheckForUpdates}
      />,
    );

    // Expiry rules (default active section).
    expect(screen.getByLabelText('Green status color')).toHaveValue('#16a34a');
    expect(screen.getByLabelText('Yellow status color')).toHaveValue('#eab308');
    expect(screen.getByLabelText('Urgent status color')).toHaveValue('#f97316');
    expect(screen.getByLabelText('Today status color')).toHaveValue('#dc2626');
    expect(screen.getByLabelText('Expired status color')).toHaveValue('#7f1d1d');

    nav('Workspace');
    expect(screen.getByLabelText('Currency code')).toHaveValue('OMR');
    expect(screen.getByLabelText('Currency symbol')).toHaveValue('ر.ع.');
    expect(screen.getByLabelText('Currency decimals')).toHaveValue(3);
    expect(screen.getByLabelText('Primary expiry column')).toHaveValue('visa_expiry');
    expect(screen.getByLabelText('Theme default')).toHaveValue('light');

    nav('Notifications');
    expect(screen.getByLabelText('Daily summary')).toBeChecked();
    expect(screen.getByLabelText('Notification day 1')).toHaveValue(90);

    // Cloud backup (PR1) added a fifth inner-navigation entry, so the old
    // document-wide "no backup text" assertion is scoped to the About section
    // it was written for: About & updates still carries no backup UI.
    expect(screen.getByRole('button', { name: 'Backup & recovery' })).toBeInTheDocument();
    nav('About & updates');
    const aboutSection = screen.getByRole('region', { name: 'Application updates' });
    expect(within(aboutSection).getByText('Version 1.2.3')).toBeInTheDocument();
    expect(within(aboutSection).queryByText(/Resend/i)).not.toBeInTheDocument();
    expect(within(aboutSection).queryByText(/backup/i)).not.toBeInTheDocument();

    // Local-first changes across sections, plus the update action.
    nav('Expiry rules');
    fireEvent.change(screen.getByLabelText('Green status color'), { target: { value: '#008000' } });
    nav('Notifications');
    fireEvent.click(screen.getByLabelText('Daily summary'));
    nav('About & updates');
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));

    expect(onSettingsChange).toHaveBeenCalled();
    const latestSettings = onSettingsChange.mock.calls.at(-1)?.[0];
    expect(latestSettings).toMatchObject({
      thresholds: { colors: { Valid: '#008000' } },
      dailySummaryEnabled: false,
    });
    expect(onCheckForUpdates).toHaveBeenCalledTimes(1);
  });

  it('resolves a blank persisted primary expiry id to the real primary expiry column (B4)', () => {
    render(
      <SettingsPage
        role="admin"
        columns={[
          { id: 'name', name: 'Full Name', type: 'text' },
          { id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', isPrimaryExpiry: true },
        ]}
        settings={{ primaryExpiryColumnId: '' }}
        onSettingsChange={vi.fn()}
      />,
    );

    nav('Workspace');
    const select = screen.getByLabelText('Primary expiry column') as HTMLSelectElement;
    expect(select.value).toBe('visa_expiry');
  });

  it('renders weekly summary controls and persists their values (B4)', () => {
    const onSettingsChange = vi.fn();
    render(
      <SettingsPage
        role="admin"
        columns={[{ id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry' }]}
        onSettingsChange={onSettingsChange}
      />,
    );

    nav('Notifications');
    fireEvent.click(screen.getByLabelText('Weekly summary'));
    fireEvent.change(screen.getByLabelText('Weekly summary day'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Weekly summary time'), { target: { value: '17:30' } });
    fireEvent.change(screen.getByLabelText('Daily summary time'), { target: { value: '08:15' } });

    expect(onSettingsChange).toHaveBeenCalled();
    const latest = onSettingsChange.mock.calls.at(-1)?.[0];
    expect(latest).toMatchObject({
      weeklySummaryEnabled: true,
      weeklySummaryDay: 5,
      weeklySummaryTime: '17:30',
      dailySummaryTime: '08:15',
    });
  });

  it('associates notification labels with controls and stacks notification layout on narrow screens', () => {
    render(<SettingsPage role="admin" />);

    nav('Notifications');
    const controls: Array<[string, string]> = [
      ['Notification day 1', 'settings-notification-day-0'],
      ['Daily summary', 'settings-daily-summary-enabled'],
      ['Weekly summary', 'settings-weekly-summary-enabled'],
      ['Daily summary time', 'settings-daily-summary-time'],
      ['Weekly summary day', 'settings-weekly-summary-day'],
      ['Weekly summary time', 'settings-weekly-summary-time'],
    ];
    for (const [label, id] of controls) {
      expect(document.querySelector(`label[for="${id}"]`)).not.toBeNull();
      expect(document.getElementById(id)).toBe(screen.getByLabelText(label));
    }

    // jsdom has no layout engine, so this locks the responsive CSS contract:
    // the side-by-side notification groups and field grids must collapse
    // instead of squeezing labels into controls, and the email form has a
    // real grid/field layout rather than unstyled inline labels.
    const css = readFileSync(
      resolve(__dirname, '../src/features/settings/settings.css'),
      'utf8',
    );
    expect(css).toMatch(/\.settings-email\s*\{[^}]*display:\s*grid/s);
    expect(css).toMatch(/\.settings-email__field\s*\{[^}]*display:\s*grid/s);
    expect(css).not.toMatch(/\.settings-email__toggle\s*\{[^}]*max-width:/s);
    expect(css).not.toMatch(/\.settings-email__field\s*\{[^}]*max-width:/s);
    expect(css).not.toMatch(/\.settings-help\s*\{[^}]*max-width:/s);
    expect(css).toContain('.settings-email__field textarea');
    expect(css).toMatch(
      /@media \(max-width: 900px\)[\s\S]*\.settings-alert-options\s*\{[^}]*grid-template-columns:\s*1fr/,
    );
    expect(css).toMatch(
      /@media \(max-width: 560px\)[\s\S]*\.settings-field-grid--four,[\s\S]*grid-template-columns:\s*1fr/,
    );
  });

  it('preserves every email preference and its save payload without provider copy', async () => {
    const upsert = vi.fn(async () => ({ data: [], error: null }));
    const emailPrefsClient = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: {
                key: 'email_notifications',
                value: {
                  enabled: true,
                  admin_email: 'admin@example.com',
                  expiry_digest_enabled: true,
                  expiry_recipients: ['digest@example.com'],
                },
              },
              error: null,
            })),
          })),
        })),
        upsert,
      })),
    };

    render(
      <SettingsPage
        role="admin"
        emailPrefsClient={emailPrefsClient as never}
      />,
    );
    nav('Notifications');

    const approvals = await screen.findByLabelText('Email me when an Office sign-in needs approval');
    const adminEmail = screen.getByLabelText('Administrator email (approval requests)');
    const digest = screen.getByLabelText('Send a daily expiry digest');
    const recipients = screen.getByLabelText('Digest recipients (one per line)');
    expect(approvals).toBeChecked();
    expect(adminEmail).toHaveValue('admin@example.com');
    expect(digest).toBeChecked();
    expect(recipients).toHaveValue('digest@example.com');
    expect(document.querySelector('label[for="settings-email-admin-email"]')).not.toBeNull();
    expect(document.getElementById('settings-email-admin-email')).toBe(adminEmail);
    expect(screen.queryByText(/Resend|API key|Edge Function/i)).not.toBeInTheDocument();

    fireEvent.change(adminEmail, { target: { value: 'new-admin@example.com' } });
    fireEvent.change(recipients, {
      target: { value: 'one@example.com\ntwo@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save email preferences' }));

    expect(await screen.findByText('Email preferences saved.')).toBeInTheDocument();
    expect(upsert).toHaveBeenCalledWith([{
      key: 'email_notifications',
      value: {
        enabled: true,
        admin_email: 'new-admin@example.com',
        expiry_digest_enabled: true,
        expiry_recipients: ['one@example.com', 'two@example.com'],
        // Full identifiers are the default; this row never stored the key.
        include_full_ids: true,
      },
    }], { onConflict: 'key' });
  });

  it('keeps full-identifier sharing ON by default and lets the Admin opt out', async () => {
    const upsert = vi.fn(async () => ({ data: [], error: null }));
    const emailPrefsClient = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: null,
              error: null,
            })),
          })),
        })),
        upsert,
      })),
    };

    render(
      <SettingsPage role="admin" emailPrefsClient={emailPrefsClient as never} />,
    );
    nav('Notifications');

    const includeFullIds = await screen.findByLabelText(
      'Include full Passport / Civil ID values in the emailed PDF',
    );
    // Default ON: the PDF goes to the Admin mailbox, who may need to call the
    // customer from the email alone.
    expect(includeFullIds).toBeChecked();

    // Opting out is recorded in the save payload.
    fireEvent.click(includeFullIds);
    fireEvent.click(screen.getByRole('button', { name: 'Save email preferences' }));
    expect(await screen.findByText('Email preferences saved.')).toBeInTheDocument();
    expect(upsert).toHaveBeenCalledWith([{
      key: 'email_notifications',
      value: {
        enabled: false,
        admin_email: null,
        expiry_digest_enabled: false,
        expiry_recipients: [],
        include_full_ids: false,
      },
    }], { onConflict: 'key' });

    // The warning is visible so the administrator knows what the PDF carries.
    expect(screen.getByText(/sends sensitive passport and Civil ID numbers/i)).toBeInTheDocument();
    expect(screen.getByText(/on by default/i)).toBeInTheDocument();

    // The opt-out is reflected in the UI state as well.
    expect(includeFullIds).not.toBeChecked();
  });

  it('does not render email preferences for Office at all', async () => {
    render(<SettingsPage role="office" />);
    // Office accounts never reach the settings screen, so they cannot reach the
    // full-identifier opt-in either.
    expect(screen.getByRole('alert', { name: 'Settings access' })).toBeInTheDocument();
    expect(screen.getByText('Settings unavailable')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Include full Passport / Civil ID values in the emailed PDF'),
    ).not.toBeInTheDocument();
  });

  it('confirms before signing out all Office sessions and keeps the administrator signed in', async () => {
    const onSignOutAllOfficeSessions = vi.fn(async () => ({
      officeUsers: 1,
      authSessionsDeleted: 3,
      requestsRevoked: 2,
    }));
    render(
      <SettingsPage
        role="admin"
        onSignOutAllOfficeSessions={onSignOutAllOfficeSessions}
      />,
    );

    nav('Workspace');
    expect(screen.getByText(/You stay signed in, and business records are not changed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out all office sessions' }));

    let dialog = screen.getByRole('dialog', { name: 'Sign out all office sessions?' });
    expect(within(dialog).getByText(/every Office user on every device/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/You stay signed in/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onSignOutAllOfficeSessions).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Sign out all office sessions?' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out all office sessions' }));
    dialog = screen.getByRole('dialog', { name: 'Sign out all office sessions?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out all office sessions' }));

    expect(await screen.findByText('All Office sessions are signed out. 3 sessions ended.')).toBeInTheDocument();
    expect(onSignOutAllOfficeSessions).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Sign out all office sessions?' })).not.toBeInTheDocument();
  });

  it('keeps the Office sign-out confirmation open with the server error on failure', async () => {
    const onSignOutAllOfficeSessions = vi.fn(async () => {
      throw new Error('Only administrators may sign out Office sessions');
    });
    render(
      <SettingsPage
        role="admin"
        onSignOutAllOfficeSessions={onSignOutAllOfficeSessions}
      />,
    );

    nav('Workspace');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out all office sessions' }));
    const dialog = screen.getByRole('dialog', { name: 'Sign out all office sessions?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out all office sessions' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Only administrators may sign out Office sessions',
    );
    expect(dialog).toBeInTheDocument();
  });

  it('disables Office session sign-out when the host does not supply the server action', () => {
    render(<SettingsPage role="admin" />);

    nav('Workspace');
    expect(screen.getByRole('button', { name: 'Sign out all office sessions' })).toBeDisabled();
    expect(screen.getByText('Office session sign-out is unavailable right now.')).toBeInTheDocument();
  });

  it('keeps the stale primary expiry id fallback honest for unknown columns (B4)', () => {
    render(
      <SettingsPage
        role="admin"
        columns={[{ id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', isPrimaryExpiry: true }]}
        settings={{ primaryExpiryColumnId: 'removed_column' }}
        onSettingsChange={vi.fn()}
      />,
    );

    nav('Workspace');
    expect((screen.getByLabelText('Primary expiry column') as HTMLSelectElement).value).toBe('visa_expiry');
  });

  it('shows the settings page context in the top bar instead of a blank strip (B4)', () => {
    render(
      <AppShell
        activeView={'settings' as never}
        profile={{ id: 'u1', email: 'admin@dks.local', fullName: 'Admin', role: 'admin' } as never}
      />,
    );

    const banner = screen.getByRole('banner', { name: 'DKS top bar' });
    // FIXES_UI §3.1: the top bar shows the current page title (not an empty
    // strip). The old breadcrumb ("DKS / …") and section eyebrow
    // ("Administration") are removed.
    expect(banner).toHaveTextContent('Settings');
    expect(banner).not.toHaveTextContent('Administration');
  });
});

describe('About & updates (R2-06)', () => {
  afterEach(() => {
    delete (window as unknown as { dks?: unknown }).dks;
  });

  it('shows the real app version and Tacenta credit with a decorative GitHub mark', async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    (window as unknown as { dks: Record<string, unknown> }).dks = {
      appVersion: '4.2.0',
      openExternal,
    };

    render(<SettingsPage role="admin" onCheckForUpdates={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /About & updates/i }));

    expect(screen.getByText('DKS')).toBeInTheDocument();
    expect(screen.getByLabelText('Version 4.2.0')).toHaveTextContent('Version 4.2.0');
    const author = screen.getByText(/Made by Tacenta/);
    expect(author).toBeInTheDocument();

    const githubMark = author.querySelector('.settings-about__github');
    expect(githubMark).not.toBeNull();
    expect(githubMark?.querySelector('svg')).not.toBeNull();
    expect(githubMark?.closest('a, button')).toBeNull();
    expect(screen.queryByRole('link', { name: /GitHub/i })).not.toBeInTheDocument();
    if (githubMark) {
      fireEvent.click(githubMark);
    }
    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.queryByText(/Resend/i)).not.toBeInTheDocument();
    // The About card keeps the update check.
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeInTheDocument();
  });

  it('prefers an explicit version prop and never renders a placeholder', () => {
    render(<SettingsPage role="admin" appVersion="9.9.9" />);
    fireEvent.click(screen.getByRole('button', { name: /About & updates/i }));
    expect(screen.getByLabelText('Version 9.9.9')).toBeInTheDocument();
    expect(screen.queryByText(/Unavailable/i)).not.toBeInTheDocument();
    expect(screen.getByText('Version 9.9.9')).toBeInTheDocument();
  });
});

describe('settings application updates (mocked bridge)', () => {
  function fakeBridge(state: {
    status: string;
    version?: string;
    progress?: number;
    errorKind?: 'check' | 'download';
  }) {
    let listener: ((next: typeof state) => void) | undefined;
    return {
      bridge: {
        checkForUpdates: vi.fn(async () => state),
        restartToUpdate: vi.fn(async () => true),
        onStatus: vi.fn((next: (typeof listener)) => {
          listener = next as typeof listener;
          return () => undefined;
        }),
      },
      emit: (next: typeof state) => listener?.(next),
    };
  }

  it('reports up to date only after a real bridge check', async () => {
    const { bridge } = fakeBridge({ status: 'not-available' });
    render(<SettingsPage role="admin" updater={bridge as never} />);

    nav('About & updates');

    expect(await screen.findByText('DKS is up to date.')).toBeInTheDocument();
    expect(bridge.checkForUpdates).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Restart to install' })).not.toBeInTheDocument();
  });

  it('shows download progress, then offers an explicit user-approved restart', async () => {
    const { bridge, emit } = fakeBridge({ status: 'downloading', version: '0.2.0', progress: 42 });
    render(<SettingsPage role="admin" updater={bridge as never} />);

    nav('About & updates');
    expect(await screen.findByText('Downloading update 0.2.0… 42%')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart to install' })).not.toBeInTheDocument();
    expect(bridge.restartToUpdate).not.toHaveBeenCalled();

    emit({ status: 'downloaded', version: '0.2.0' });
    expect(await screen.findByText('Update 0.2.0 is ready to install.')).toBeInTheDocument();
    expect(screen.queryByText(/Your records stay on this device/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restart to install' }));
    expect(bridge.restartToUpdate).toHaveBeenCalledTimes(1);
  });

  it('says update checks are unavailable without claiming DKS is up to date', async () => {
    const { bridge } = fakeBridge({ status: 'disabled' });
    render(<SettingsPage role="admin" updater={bridge as never} />);

    nav('About & updates');

    expect(await screen.findByText('Update checks are unavailable right now.')).toBeInTheDocument();
    expect(screen.queryByText(/development build/i)).not.toBeInTheDocument();
    expect(screen.queryByText('DKS is up to date.')).not.toBeInTheDocument();
  });

  it('turns check failures into a retryable could-not-check message', async () => {
    const { bridge } = fakeBridge({ status: 'error', errorKind: 'check' });
    render(<SettingsPage role="admin" updater={bridge as never} />);

    nav('About & updates');

    expect(await screen.findByText(
      'Could not check for updates. Check your internet connection and try again.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled();
  });

  it('distinguishes a final installer download failure from a check failure', async () => {
    const { bridge } = fakeBridge({
      status: 'error',
      version: '0.2.0',
      errorKind: 'download',
    });
    render(<SettingsPage role="admin" updater={bridge as never} />);

    nav('About & updates');

    expect(await screen.findByText(
      'Update 0.2.0 download failed. Check your internet connection and try again.',
    )).toBeInTheDocument();
    expect(screen.queryByText(/Could not check for updates/i)).not.toBeInTheDocument();
  });

  it('never claims a check happened without a desktop bridge', async () => {
    render(<SettingsPage role="admin" updater={null} />);

    nav('About & updates');
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));

    expect(await screen.findByText('Update checks are unavailable right now.')).toBeInTheDocument();
    expect(screen.queryByText(/development build/i)).not.toBeInTheDocument();
    expect(screen.queryByText('DKS is up to date.')).not.toBeInTheDocument();
    expect(screen.queryByText('Update check requested.')).not.toBeInTheDocument();
  });
});

describe('settings save banner lifecycle', () => {
  // Real timers: React 18's scheduler does not drain reliably under fake
  // timers in this jsdom setup. The success window is 3.5s, so the waits
  // below stay just over that.
  const HIDE_TIMEOUT = SAVE_BANNER_VISIBLE_MS + 1500;

  it('renders no save banner when the page first opens', () => {
    render(<SettingsPage role="admin" onSettingsChange={vi.fn()} />);

    expect(screen.queryByText(/Settings saved/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cloud sync failed/i)).not.toBeInTheDocument();
  });

  it('shows the success banner after a save, auto-hides it, and re-shows it on the next save', async () => {
    const onSettingsChange = vi.fn().mockResolvedValue(undefined);
    render(<SettingsPage role="admin" onSettingsChange={onSettingsChange} />);

    fireEvent.change(screen.getByLabelText('Green status color'), { target: { value: '#008000' } });
    expect(await screen.findByText('Settings saved to the workspace.')).toBeInTheDocument();

    // The success banner removes itself without any user action.
    await waitFor(
      () => expect(screen.queryByText('Settings saved to the workspace.')).not.toBeInTheDocument(),
      { timeout: HIDE_TIMEOUT },
    );

    // A second save brings the banner back with a fresh auto-hide window.
    fireEvent.change(screen.getByLabelText('Green status color'), { target: { value: '#009000' } });
    expect(await screen.findByText('Settings saved to the workspace.')).toBeInTheDocument();
    await waitFor(
      () => expect(screen.queryByText(/Settings saved/i)).not.toBeInTheDocument(),
      { timeout: HIDE_TIMEOUT },
    );
  });

  it('keeps the save-failure banner visible past the success window until dismissed', async () => {
    const onSettingsChange = vi.fn().mockRejectedValue(new Error('network offline'));
    render(<SettingsPage role="admin" onSettingsChange={onSettingsChange} />);

    fireEvent.change(screen.getByLabelText('Green status color'), { target: { value: '#008000' } });
    const failureBanner = await screen.findByRole('alert');
    expect(failureBanner).toHaveTextContent(/cloud sync failed/i);

    // Error banners never auto-hide, even well beyond the success window.
    await new Promise((resolve) => setTimeout(resolve, HIDE_TIMEOUT));
    expect(screen.getByRole('alert')).toHaveTextContent(/cloud sync failed/i);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
    await waitFor(() => expect(screen.queryByText(/cloud sync failed/i)).not.toBeInTheDocument());
  });

  it('replaces a persistent failure banner with the transient success banner on the next edit', async () => {
    const onSettingsChange = vi.fn()
      .mockRejectedValueOnce(new Error('network offline'))
      .mockResolvedValueOnce(undefined);
    render(<SettingsPage role="admin" onSettingsChange={onSettingsChange} />);

    fireEvent.change(screen.getByLabelText('Green status color'), { target: { value: '#008000' } });
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    // A new edit is an implicit retry and must clear the persistent error.
    fireEvent.change(screen.getByLabelText('Yellow status color'), { target: { value: '#eab309' } });
    expect(await screen.findByText('Settings saved to the workspace.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
