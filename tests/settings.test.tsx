import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../src/renderer/components/AppShell';
import { SettingsPage } from '../src/features/settings/SettingsPage';

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

    nav('About & updates');
    expect(screen.getByText('Version 1.2.3')).toBeInTheDocument();
    expect(screen.getByText('Resend:', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/backup/i)).not.toBeInTheDocument();

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

  it('shows the real app version, Tacenta credit and opens GitHub externally', async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    (window as unknown as { dks: Record<string, unknown> }).dks = {
      appVersion: '4.2.0',
      openExternal,
    };

    render(<SettingsPage role="admin" onCheckForUpdates={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /About & updates/i }));

    expect(screen.getByText('DKS')).toBeInTheDocument();
    expect(screen.getByLabelText('Version 4.2.0')).toHaveTextContent('Version 4.2.0');
    expect(screen.getByText(/Made by Tacenta/)).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Tacenta on GitHub' });
    fireEvent.click(link);

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://github.com/tacenta2k');
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
  function fakeBridge(state: { status: string; version?: string; progress?: number }) {
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
    expect(await screen.findByText(/Update 0\.2\.0 is ready to install/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restart to install' }));
    expect(bridge.restartToUpdate).toHaveBeenCalledTimes(1);
  });

  it('says plainly that development builds cannot check for updates', async () => {
    const { bridge } = fakeBridge({ status: 'disabled' });
    render(<SettingsPage role="admin" updater={bridge as never} />);

    nav('About & updates');

    expect(await screen.findByText(/not available in this development build/i)).toBeInTheDocument();
    expect(screen.queryByText('DKS is up to date.')).not.toBeInTheDocument();
  });

  it('turns bridge failures into a retryable error message', async () => {
    const { bridge } = fakeBridge({ status: 'error' });
    render(<SettingsPage role="admin" updater={bridge as never} />);

    nav('About & updates');

    expect(await screen.findByText(/Update check failed/i)).toBeInTheDocument();
  });

  it('never claims a check happened without a desktop bridge', async () => {
    render(<SettingsPage role="admin" updater={null} />);

    nav('About & updates');
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));

    expect(await screen.findByText(/not available in this development build/i)).toBeInTheDocument();
    expect(screen.queryByText('DKS is up to date.')).not.toBeInTheDocument();
    expect(screen.queryByText('Update check requested.')).not.toBeInTheDocument();
  });
});
