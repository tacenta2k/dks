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

  it('shows Download and Later for an available update for both roles', () => {
    const { bridge, checkForUpdates } = fakeUpdater();
    render(
      <AppShell
        profile={profileFor('admin')}
        updateState={{ status: 'available', version: '0.1.2' }}
        updater={bridge}
      />,
    );

    expect(screen.getByText('Update 0.1.2 available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart to install' })).not.toBeInTheDocument();
    // Downloading is an explicit user action, not a background poll.
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it('shows progress while downloading and no action buttons', () => {
    const { bridge } = fakeUpdater();
    render(
      <AppShell
        profile={profileFor('office')}
        updateState={{ status: 'downloading', version: '0.1.2', progress: 42 }}
        updater={bridge}
      />,
    );

    expect(screen.getByText('Downloading… 42%')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart to install' })).not.toBeInTheDocument();
  });

  it('starts the download through the existing bridge on Download', async () => {
    const { bridge, checkForUpdates } = fakeUpdater();
    const onUpdateStateChange = vi.fn();
    render(
      <AppShell
        profile={profileFor('admin')}
        updateState={{ status: 'available', version: '0.1.2' }}
        updater={bridge}
        onUpdateStateChange={onUpdateStateChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onUpdateStateChange).toHaveBeenCalled());
  });

  it('Later hides the pill until the next check, not forever', async () => {
    const { bridge, checkForUpdates } = fakeUpdater({ status: 'available', version: '0.1.2' });
    const onUpdateStateChange = vi.fn();
    const { rerender } = render(
      <AppShell
        profile={profileFor('admin')}
        updateState={{ status: 'available', version: '0.1.2' }}
        updater={bridge}
        onUpdateStateChange={onUpdateStateChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByText('Update 0.1.2 available')).not.toBeInTheDocument());
    // Dismissing never triggers a check of its own.
    expect(checkForUpdates).not.toHaveBeenCalled();

    // The next check (a new status) brings the pill back.
    const downloaded = { status: 'downloaded', version: '0.1.2' } as const;
    rerender(
      <AppShell
        profile={profileFor('admin')}
        updateState={downloaded}
        updater={bridge}
        onUpdateStateChange={onUpdateStateChange}
      />,
    );

    expect(await screen.findByText('Update 0.1.2 ready')).toBeInTheDocument();
  });

  it('a Later dismissed for one release does not hide a different release', async () => {
    const { bridge } = fakeUpdater({ status: 'available', version: '0.1.2' });
    const onUpdateStateChange = vi.fn();
    const { rerender } = render(
      <AppShell
        profile={profileFor('admin')}
        updateState={{ status: 'available', version: '0.1.2' }}
        updater={bridge}
        onUpdateStateChange={onUpdateStateChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByText('Update 0.1.2 available')).not.toBeInTheDocument());

    // A different version is a different decision.
    rerender(
      <AppShell
        profile={profileFor('admin')}
        updateState={{ status: 'available', version: '0.1.3' }}
        updater={bridge}
        onUpdateStateChange={onUpdateStateChange}
      />,
    );

    expect(await screen.findByText('Update 0.1.3 available')).toBeInTheDocument();
  });
});
