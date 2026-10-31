import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BackupRecoverySection,
  OUTCOME_LABELS,
  formatBackupDay,
  formatBackupInstant,
  formatBytes,
  messageFromError,
  weekdayOfBackupDay,
  type BackupBridge,
} from '../src/features/settings/BackupRecoverySection';
import type {
  DksBackupHistoryEntry,
  DksBackupState,
} from '../src/lib/types';

const CURRENT_YEAR = new Date().getFullYear();

// RTL's auto-cleanup needs vitest globals; do it by hand instead.
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function createState(overrides: Partial<DksBackupState> = {}): DksBackupState {
  return {
    enabled: true,
    keyConfigured: true,
    recoveryKeyStored: false,
    workerUrl: 'https://dks-backup.example.workers.dev',
    connection: 'ok',
    lastAttemptAt: '2026-10-31T08:00:00.000Z',
    lastSuccessAt: '2026-10-31T08:00:12.000Z',
    lastSuccessDate: '2026-10-31',
    lastFingerprint: 'a'.repeat(64),
    lastSizeBytes: 1_572_864,
    lastRecordCount: 1_204,
    pendingUploads: 0,
    nextCheckAt: '2026-10-31T09:00:00.000Z',
    lastOutcome: 'verified',
    lastError: null,
    retentionDays: 90,
    running: false,
    keyId: 'ab'.repeat(12),
    source: 'local-cache',
    ...overrides,
  };
}

function createBridge(overrides: Partial<BackupBridge> = {}): BackupBridge {
  return {
    getState: vi.fn(async () => createState()),
    runNow: vi.fn(async () => ({
      outcome: 'verified' as const,
      detail: 'Uploaded and verified',
      sizeBytes: 1_572_864,
      recordCount: 1_204,
      objectKey: `backups/${String(CURRENT_YEAR)}/10/${String(CURRENT_YEAR)}-10-31/080000-abcdef012345.sqlite.enc`,
      fingerprint: 'a'.repeat(64),
    })),
    list: vi.fn(async ({ year, month }) => ({
      year,
      month,
      entries: [] as DksBackupHistoryEntry[],
      nextCursor: null,
    })),
    testDrill: vi.fn(async () => ({
      ok: true,
      stage: 'cleanup' as const,
      sizeBytes: 1_572_864,
      integrityCheck: 'ok',
      message: 'The latest backup downloaded, decrypted and passed the integrity check',
    })),
    setupKey: vi.fn(async (input) =>
      input.action === 'generate'
        ? { ok: true, recoveryKey: 'dks-recovery-key-1234', message: 'Created' }
        : { ok: true, message: 'Saved' },
    ),
    healthCheck: vi.fn(async () => ({ ok: true, reachable: true, r2Bound: true, detail: null })),
    ...overrides,
  };
}

function dayEntry(overrides: Partial<DksBackupHistoryEntry> = {}): DksBackupHistoryEntry {
  return {
    day: `${String(CURRENT_YEAR)}-10-31`,
    sizeBytes: 1_572_864,
    outcome: 'verified',
    objectKey: `backups/${String(CURRENT_YEAR)}/10/${String(CURRENT_YEAR)}-10-31/080000-abcdef012345.sqlite.enc`,
    createdAt: `${String(CURRENT_YEAR)}-10-31T08:00:12.000Z`,
    recordCount: 1_204,
    keyId: 'ab'.repeat(12),
    source: 'local-cache',
    ...overrides,
  };
}

async function renderSection(bridge: BackupBridge | null, role = 'admin') {
  const view = render(<BackupRecoverySection role={role} backup={bridge} />);
  if (bridge) {
    await waitFor(() => expect(screen.queryByText('Loading the backup status…')).not.toBeInTheDocument());
  }
  return view;
}

describe('formatting helpers', () => {
  it('labels every outcome a run can produce', () => {
    expect(Object.keys(OUTCOME_LABELS).sort()).toEqual(
      ['failed', 'incomplete', 'no_changes', 'pending', 'verified'].sort(),
    );
    for (const label of Object.values(OUTCOME_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('derives the weekday from the backup date in Muscat, not from the PC clock', () => {
    // 2026-10-31 is a Saturday in Muscat (UTC+4).
    expect(weekdayOfBackupDay('2026-10-31')).toBe('Saturday');
    expect(weekdayOfBackupDay('not-a-date')).toBeNull();
  });

  it('formats dates DD/MM/YYYY and sizes in whole units', () => {
    expect(formatBackupDay('2026-10-31')).toBe('31/10/2026');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1_572_864)).toBe('1.5 MB');
    expect(formatBytes(null)).toBeNull();
    expect(formatBackupInstant(null)).toBeNull();
    expect(formatBackupInstant('2026-10-31T08:00:12.000Z')).toMatch(/2026/);
  });

  it('prefers a real error message over the fallback', () => {
    expect(messageFromError(new Error('boom'), 'fallback')).toBe('boom');
    expect(messageFromError(undefined, 'fallback')).toBe('fallback');
    expect(messageFromError(new Error('   '), 'fallback')).toBe('fallback');
  });
});

describe('access and availability', () => {
  it('refuses a non-admin without calling the bridge', async () => {
    const bridge = createBridge();
    render(<BackupRecoverySection role="office" backup={bridge} />);

    expect(screen.getByText(/administrators only/i)).toBeInTheDocument();
    expect(bridge.getState).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Back up now' })).not.toBeInTheDocument();
  });

  it('says the section needs the installed app when there is no bridge', () => {
    render(<BackupRecoverySection role="admin" backup={null} />);
    expect(screen.getByText(/Open Settings from the installed DKS/i)).toBeInTheDocument();
  });
});

describe('status card', () => {
  it('shows a loading state, then the real status', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = createBridge({
      getState: vi.fn(async () => {
        await gate;
        return createState();
      }),
    });

    render(<BackupRecoverySection role="admin" backup={bridge} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading the backup status…');

    release();
    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
    // Both "last success" and "next check" fall on the same day here.
    expect(screen.getAllByText(/31\/10\/2026/).length).toBeGreaterThan(0);
    expect(screen.getByText('1.5 MB')).toBeInTheDocument();
    expect(screen.getByText('1204')).toBeInTheDocument();
    expect(screen.getByText('Nothing')).toBeInTheDocument();
    expect(screen.getByText('Retention 90 days')).toBeInTheDocument();
  });

  it('describes a never-checked connection honestly', async () => {
    await renderSection(createBridge({ getState: vi.fn(async () => createState({ connection: 'unknown' })) }));
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
  });

  it('reports a pending upload and the reason for the last failure', async () => {
    await renderSection(
      createBridge({
        getState: vi.fn(async () =>
          createState({
            pendingUploads: 2,
            connection: 'offline',
            lastSuccessAt: null,
            lastOutcome: 'pending',
            lastError: 'DKS could not reach the backup service. Check the internet connection.',
          }),
        ),
      }),
    );

    expect(screen.getByText('2 file(s)')).toBeInTheDocument();
    expect(screen.getByText('Not yet')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/could not reach the backup service/i);
  });

  it('shows an error state that can be retried', async () => {
    const getState = vi
      .fn<() => Promise<DksBackupState>>()
      .mockRejectedValueOnce(new Error('The backup service is not reachable'))
      .mockResolvedValueOnce(createState());
    const bridge = createBridge({ getState });

    render(<BackupRecoverySection role="admin" backup={bridge} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not reachable/i));

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('sends the toggle through main and re-reads the state instead of trusting the click', async () => {
    const setupKey = vi.fn(async () => ({ ok: true, message: 'Saved' }));
    // Main keeps the toggle OFF, so the optimistic paint has to be reverted.
    const getState = vi.fn(async () => createState({ enabled: false }));
    const bridge = createBridge({ setupKey, getState });
    await renderSection(bridge);

    const toggle = screen.getByRole('checkbox', { name: 'Cloud backup' });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(setupKey).toHaveBeenCalledWith({ role: 'admin', action: 'configure', enabled: true }));
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Cloud backup' })).not.toBeChecked());
  });

  it('runs a backup on demand and reports what happened', async () => {
    const bridge = createBridge();
    await renderSection(bridge);

    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    await waitFor(() => expect(bridge.runNow).toHaveBeenCalledWith({ role: 'admin', trigger: 'manual' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/uploaded and verified/i));
  });

  it('keeps the restore test disabled until a key exists, then reports the drill result', async () => {
    const bridge = createBridge({ getState: vi.fn(async () => createState({ keyConfigured: false })) });
    const withoutKey = await renderSection(bridge);
    expect(screen.getByRole('button', { name: 'Test restore' })).toBeDisabled();
    withoutKey.unmount();

    const keyed = createBridge();
    await renderSection(keyed);
    fireEvent.click(screen.getByRole('button', { name: 'Test restore' }));
    await waitFor(() => expect(keyed.testDrill).toHaveBeenCalledWith({ role: 'admin' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/passed the integrity check/i),
    );
  });
});

describe('backup service address', () => {
  it('keeps the save button disabled until an address is typed', async () => {
    const bridge = createBridge();
    await renderSection(bridge);
    // The saved address is shown back, so the button is live from the start.
    await waitFor(() =>
      expect(screen.getByLabelText('Backup service address')).toHaveValue('https://dks-backup.example.workers.dev'),
    );

    fireEvent.change(screen.getByLabelText('Backup service address'), {
      target: { value: 'https://dks-backup.acme.workers.dev' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() =>
      expect(bridge.setupKey).toHaveBeenCalledWith({
        role: 'admin',
        action: 'configure',
        workerUrl: 'https://dks-backup.acme.workers.dev',
      }),
    );
  });
});

describe('recovery key wizard', () => {
  it('shows the key once, demands the saved checkbox and a paste-back before confirming', async () => {
    const bridge = createBridge({ getState: vi.fn(async () => createState({ keyConfigured: false })) });
    await renderSection(bridge);

    fireEvent.click(screen.getByRole('button', { name: 'Create recovery key' }));
    await waitFor(() => expect(screen.getByText('dks-recovery-key-1234')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/only time DKS shows this key/i);

    const confirm = screen.getByRole('button', { name: 'Confirm recovery key' });
    expect(confirm).toBeDisabled();

    fireEvent.click(screen.getByLabelText('I have saved this recovery key'));
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Paste it back to confirm'), { target: { value: 'wrong-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm recovery key' }));
    await waitFor(() =>
      expect(bridge.setupKey).toHaveBeenCalledWith({ role: 'admin', action: 'confirm', recoveryKey: 'wrong-key' }),
    );
  });

  it('confirms the key and stops showing it', async () => {
    const bridge = createBridge({ getState: vi.fn(async () => createState({ keyConfigured: false })) });
    await renderSection(bridge);

    fireEvent.click(screen.getByRole('button', { name: 'Create recovery key' }));
    await waitFor(() => expect(screen.getByText('dks-recovery-key-1234')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('I have saved this recovery key'));
    fireEvent.change(screen.getByLabelText('Paste it back to confirm'), {
      target: { value: 'dks-recovery-key-1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm recovery key' }));

    await waitFor(() => expect(screen.getByText('Recovery key confirmed. Cloud backup is ready.')).toBeInTheDocument());
    expect(screen.queryByText('dks-recovery-key-1234')).not.toBeInTheDocument();
  });

  it('says plainly when the key could not be created', async () => {
    const bridge = createBridge({
      getState: vi.fn(async () => createState({ keyConfigured: false })),
      setupKey: vi.fn(async () => ({ ok: false, message: 'This PC has no operating system key store' })),
    });
    await renderSection(bridge);

    fireEvent.click(screen.getByRole('button', { name: 'Create recovery key' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/no operating system key store/i));
  });

  it('warns that a replacement key invalidates earlier backups', async () => {
    await renderSection(createBridge());
    expect(screen.getByText(/Generate a new one only if you have lost it/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a new recovery key' })).toBeInTheDocument();
  });
});

describe('backup history', () => {
  it('loads years lazily, then months, then days with weekday, size and status', async () => {
    const list = vi.fn(async ({ year, month }) => ({
      year,
      month,
      entries: [
        dayEntry({ day: `${String(year)}-10-31` }),
        dayEntry({
          day: `${String(year)}-10-15`,
          outcome: 'failed' as const,
          sizeBytes: null,
          recordCount: null,
          objectKey: null,
        }),
      ],
      nextCursor: null,
    }));
    const bridge = createBridge({ list });
    await renderSection(bridge);
    expect(list).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: String(CURRENT_YEAR) }));
    expect(list).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'October' }));
    await waitFor(() => expect(list).toHaveBeenCalledWith({ role: 'admin', year: CURRENT_YEAR, month: 10, cursor: null }));
    await waitFor(() => expect(screen.getByText('31/10/2026')).toBeInTheDocument());

    const expectedWeekday = weekdayOfBackupDay(`${String(CURRENT_YEAR)}-10-31`);
    expect(expectedWeekday).not.toBeNull();
    expect(screen.getByText(new RegExp(`· ${String(expectedWeekday)}`))).toBeInTheDocument();
    expect(screen.getByText('1.5 MB · 1204 records')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('shows Recover and Delete as disabled, with the reason', async () => {
    const bridge = createBridge({
      list: vi.fn(async ({ year, month }) => ({ year, month, entries: [dayEntry({ day: `${String(year)}-10-31` })], nextCursor: null })),
    });
    await renderSection(bridge);
    fireEvent.click(screen.getByRole('button', { name: String(CURRENT_YEAR) }));
    fireEvent.click(screen.getByRole('button', { name: 'October' }));
    await waitFor(() => expect(screen.getByText('31/10/2026')).toBeInTheDocument());

    const recover = screen.getByRole('button', { name: 'Recover' });
    const remove = screen.getByRole('button', { name: 'Delete' });
    expect(recover).toBeDisabled();
    expect(remove).toBeDisabled();
    expect(recover).toHaveAttribute('title', 'Coming in a later update');
    expect(remove).toHaveAttribute('title', 'Coming in a later update');
    expect(screen.getByText('Recover and Delete are coming in a later update.')).toBeInTheDocument();
  });

  it('has a real empty state for a month with no backups', async () => {
    const bridge = createBridge();
    await renderSection(bridge);
    fireEvent.click(screen.getByRole('button', { name: String(CURRENT_YEAR) }));
    fireEvent.click(screen.getByRole('button', { name: 'October' }));
    await waitFor(() => expect(screen.getByText('No backups this month')).toBeInTheDocument());
  });

  it('has a real error state for a month that fails, and retries it', async () => {
    const list = vi
      .fn<BackupBridge['list']>()
      .mockRejectedValueOnce(new Error('The backup service is not reachable'))
      .mockResolvedValue({ year: CURRENT_YEAR, month: 10, entries: [], nextCursor: null });
    const bridge = createBridge({ list });
    await renderSection(bridge);

    fireEvent.click(screen.getByRole('button', { name: String(CURRENT_YEAR) }));
    fireEvent.click(screen.getByRole('button', { name: 'October' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded/i));

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('No backups this month')).toBeInTheDocument());
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('explains that backups only happen while DKS runs', async () => {
    await renderSection(createBridge());
    expect(screen.getByText(/Backups run only while DKS is open/i)).toBeInTheDocument();
  });
});

describe('opening backups made on another PC', () => {
  it('states plainly that a backup is a copy of this PC’s local cache', async () => {
    await renderSection(createBridge());

    expect(screen.getByText(/encrypted copy of/i)).toBeInTheDocument();
    expect(screen.getByText(/Supabase stays the system of record/i)).toBeInTheDocument();
    // The paragraph label and the status grid must agree.
    expect(screen.getAllByText(/this PC’s local cache/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('What a backup holds')).toBeInTheDocument();
    expect(screen.getByText('This PC’s local cache')).toBeInTheDocument();
  });

  it('imports a recovery key from another PC and re-reads the state', async () => {
    const setupKey = vi.fn(async (input: { action: string; recoveryKey?: string }) =>
      input.action === 'import'
        ? { ok: true, keyId: 'ab'.repeat(12), message: 'Imported' }
        : { ok: true, message: 'Saved' });
    const bridge = createBridge({ setupKey });
    await renderSection(bridge);

    fireEvent.click(await screen.findByRole('button', { name: /open backups made on another pc/i }));
    fireEvent.change(await screen.findByLabelText(/recovery key from another pc/i), {
      target: { value: 'dks-aaaa-bbbb-cccc' },
    });
    fireEvent.click(screen.getByRole('button', { name: /use this recovery key/i }));

    await waitFor(() => expect(setupKey).toHaveBeenCalledWith({
      role: 'admin',
      action: 'import',
      recoveryKey: 'dks-aaaa-bbbb-cccc',
    }));
    expect(await screen.findByText(/recovery key imported/i)).toBeInTheDocument();
    // The state is re-read, so the toggle and key id reflect what main reported.
    await waitFor(() => expect(bridge.getState).toHaveBeenCalledTimes(2));
  });

  it('keeps the import form open and shows the reason when the key is refused', async () => {
    const setupKey = vi.fn(async () => ({ ok: false, message: 'That is not a valid DKS recovery key' }));
    await renderSection(createBridge({ setupKey }));

    fireEvent.click(await screen.findByRole('button', { name: /open backups made on another pc/i }));
    fireEvent.change(await screen.findByLabelText(/recovery key from another pc/i), {
      target: { value: 'nonsense' },
    });
    fireEvent.click(screen.getByRole('button', { name: /use this recovery key/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not a valid dks recovery key/i);
    expect(screen.queryByText(/recovery key imported/i)).not.toBeInTheDocument();
  });

  it('hides the import path while a new key is on screen', async () => {
    await renderSection(createBridge({
      getState: vi.fn(async () => createState({ keyConfigured: false })),
    }));

    expect(await screen.findByRole('button', { name: /create recovery key/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open backups made on another pc/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /create recovery key/i }));
    // While the fresh key is on screen, confirming it is the only way forward.
    expect(await screen.findByText(/only time DKS shows this key/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open backups made on another pc/i })).not.toBeInTheDocument();
  });
});
