import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

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
