import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import type { Profile } from '../src/features/auth/auth-types';
import type { DksUpdateState, DksUpdaterApi } from '../src/lib/types';
import { AppShell } from '../src/renderer/components/AppShell';

function fakeUpdater(checkState: DksUpdateState = { status: 'idle' }) {
  const checkForUpdates = vi.fn(async () => checkState);
  const restartToUpdate = vi.fn(async () => true);
  const onStatus = vi.fn(() => () => undefined);
  const bridge: DksUpdaterApi = {
    checkForUpdates,
    restartToUpdate,
    onStatus,
  };
  return { bridge, checkForUpdates, restartToUpdate, onStatus };
}

function profileFor(role: Profile['role']): Profile {
  return {
    id: `${role}-1`,
    email: `${role}@example.com`,
    role,
    fullName: role === 'admin' ? 'Admin' : 'Office',
  } as Profile;
}

const hiddenStates = [
  ['idle', { status: 'idle' }],
  ['checking', { status: 'checking' }],
  ['not-available', { status: 'not-available' }],
  ['disabled', { status: 'disabled' }],
  ['error', { status: 'error', version: '0.1.1' }],
  ['downloading', { status: 'downloading', version: '0.1.1', progress: 42 }],
] as const satisfies ReadonlyArray<readonly [string, DksUpdateState]>;

describe('top-bar update-ready pill', () => {
  it.each(hiddenStates)('does not render for the %s updater state', (_name, updateState) => {
    const { bridge } = fakeUpdater();
    const { container } = render(
      <AppShell profile={profileFor('office')} updateState={updateState} updater={bridge} />,
    );

    expect(container.querySelector('.topbar-update')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart to install' })).not.toBeInTheDocument();
  });

  it.each(['admin', 'office'] as const)(
    'shows the downloaded version for a signed-in %s user without an admin capability gate',
    (role) => {
      const { bridge, checkForUpdates, onStatus } = fakeUpdater();
      render(
        <AppShell
          profile={profileFor(role)}
          updateState={{ status: 'downloaded', version: '0.1.1' }}
          updater={bridge}
        />,
      );

      expect(screen.getByText('Update 0.1.1 ready')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Restart to install' })).toBeInTheDocument();
      if (role === 'office') {
        expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
      }
      // The shell renders App-owned status; it neither polls nor subscribes itself.
      expect(checkForUpdates).not.toHaveBeenCalled();
      expect(onStatus).not.toHaveBeenCalled();
    },
  );

  it('requires ConfirmDialog approval before calling the restart bridge exactly once', async () => {
    const { bridge, restartToUpdate } = fakeUpdater();
    render(
      <AppShell
        profile={profileFor('office')}
        updateState={{ status: 'downloaded', version: '0.1.1' }}
        updater={bridge}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Restart to install' }));
    let dialog = screen.getByRole('dialog', { name: 'Restart to install update?' });
    expect(dialog).toHaveTextContent(
      'Restart DKS to install update 0.1.1? Your work is already saved on this device. DKS will close and reopen.',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Restart to install update?' })).not.toBeInTheDocument();
    expect(restartToUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Restart to install' }));
    dialog = screen.getByRole('dialog', { name: 'Restart to install update?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart now' }));

    await waitFor(() => expect(restartToUpdate).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Restart to install update?' })).not.toBeInTheDocument();
    });
  });

  it('keeps Settings on the same controlled status source without a second subscription', async () => {
    const ready: DksUpdateState = { status: 'downloaded', version: '0.1.1' };
    const { bridge, onStatus } = fakeUpdater(ready);
    const onUpdateStateChange = vi.fn();
    render(
      <AppShell
        activeView={'settings' as never}
        profile={profileFor('admin')}
        updateState={ready}
        updater={bridge}
        onUpdateStateChange={onUpdateStateChange}
      />,
    );

    expect(screen.getByText('Update 0.1.1 ready')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /About & updates/i }));

    expect(
      await screen.findByText('Update 0.1.1 is ready to install.'),
    ).toBeInTheDocument();
    expect(onStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(onUpdateStateChange).toHaveBeenCalledWith(ready));
  });
});
