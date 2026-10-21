import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { SettingsPage } from '../src/features/settings/SettingsPage';

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

    expect(screen.getByLabelText('Green status color')).toHaveValue('#16a34a');
    expect(screen.getByLabelText('Yellow status color')).toHaveValue('#eab308');
    expect(screen.getByLabelText('Urgent status color')).toHaveValue('#f97316');
    expect(screen.getByLabelText('Today status color')).toHaveValue('#dc2626');
    expect(screen.getByLabelText('Expired status color')).toHaveValue('#7f1d1d');
    expect(screen.getByLabelText('Currency code')).toHaveValue('OMR');
    expect(screen.getByLabelText('Currency symbol')).toHaveValue('ر.ع.');
    expect(screen.getByLabelText('Currency decimals')).toHaveValue(3);
    expect(screen.getByLabelText('Primary expiry column')).toHaveValue('visa_expiry');
    expect(screen.getByLabelText('Theme default')).toHaveValue('light');
    expect(screen.getByLabelText('Daily summary')).toBeChecked();
    expect(screen.getByLabelText('Notification day 1')).toHaveValue(90);
    expect(screen.queryByText(/backup/i)).not.toBeInTheDocument();
    expect(screen.getByText('Version 1.2.3')).toBeInTheDocument();
    expect(screen.getByText('Resend:', { exact: true })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Green status color'), { target: { value: '#008000' } });
    fireEvent.click(screen.getByLabelText('Daily summary'));
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));

    expect(onSettingsChange).toHaveBeenCalled();
    const latestSettings = onSettingsChange.mock.calls.at(-1)?.[0];
    expect(latestSettings).toMatchObject({
      thresholds: { colors: { Valid: '#008000' } },
      dailySummaryEnabled: false,
    });
    expect(onCheckForUpdates).toHaveBeenCalledTimes(1);
  });
});
