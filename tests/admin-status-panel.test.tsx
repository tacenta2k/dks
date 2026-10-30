import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminStatusPanel } from '../src/features/diagnostics/AdminStatusPanel';
import {
  type ConnectivityQueryClient,
  createInitialConnectivityReport,
  formatSanitizedDiagnosticsText,
  runSupabaseConnectivityChecks,
} from '../src/features/diagnostics/connectivity-checks';
import { DEFAULT_SETTINGS, SettingsPage } from '../src/features/settings/SettingsPage';
import { AppShell } from '../src/renderer/components/AppShell';
import type { DksAdminLocalStatus, DksDiagnosticsApi } from '../src/lib/types';

afterEach(() => {
  cleanup();
});

function sampleLocalStatus(overrides?: Partial<DksAdminLocalStatus>): DksAdminLocalStatus {
  return {
    appVersion: '1.1.3',
    packaged: true,
    platform: 'win32',
    arch: 'x64',
    osRelease: '10.0.22631',
    electronVersion: '33.4.0',
    localStore: {
      available: true,
      schemaVersion: 4,
      failureCode: null,
    },
    sync: {
      status: 'error',
      lastSyncAt: '2026-10-29T08:15:00.000Z',
      pendingOutboxCount: 2,
      failedOutboxCount: 1,
      terminalOutboxCount: 1,
    },
    updater: {
      status: 'idle',
      version: null,
      errorKind: null,
      errorCode: null,
    },
    errorReporting: {
      enabled: true,
      pendingCount: 1,
      failedCount: 0,
      suppressedCount: 3,
      lastDeliveryOutcome: 'delivered',
      lastDeliveryAt: '2026-10-29T08:10:00.000Z',
    },
    ...overrides,
  };
}

describe('AdminStatusPanel & AppShell role visibility', () => {
  it('shows the top-bar Status button to Admin and hides it completely from Office', () => {
    const { rerender } = render(
      <AppShell
        profile={{
          id: '846536af-f3c6-47c1-8559-d13442c1490a',
          email: 'shahabasnavas123@gmail.com',
          role: 'admin',
        }}
        userEmail="shahabasnavas123@gmail.com"
      />,
    );
    expect(screen.getByRole('button', { name: /Status/i })).toBeTruthy();

    rerender(
      <AppShell
        profile={{
          id: '2a959122-d789-4f2e-8fdf-958260c2e3f9',
          email: 'amervisamedical1dks@gmail.com',
          role: 'office',
        }}
        userEmail="amervisamedical1dks@gmail.com"
      />,
    );
    expect(screen.queryByRole('button', { name: /Status/i })).toBeNull();
  });

  it('opens an accessible dialog showing truthful Not checked / Unknown states before probing, runs async checks on demand, and copies sanitized diagnostics', async () => {
    const getAdminStatus = vi.fn().mockResolvedValue(sampleLocalStatus());
    const diagnosticsApi: DksDiagnosticsApi = {
      getAdminStatus,
      captureError: vi.fn(),
      claimErrorReports: vi.fn(),
      completeErrorReport: vi.fn(),
      setErrorReportingEnabled: vi.fn(),
      syncWorkspaceErrorReporting: vi.fn(),
    };

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: 'v2' }), { status: 200 }),
    );
    const queryResult = { data: [{ key: 'theme' }], error: null };
    const dataClient: ConnectivityQueryClient = {
      from: () => ({
        select: () =>
          Object.assign(Promise.resolve(queryResult), {
            limit: () => Promise.resolve(queryResult),
          }),
      }),
    };
    const copiedTexts: string[] = [];

    render(
      <AdminStatusPanel
        role="admin"
        diagnosticsApi={diagnosticsApi}
        supabaseUrl="https://example.supabase.co"
        supabaseAnonKey="sb_publishable_test"
        dataClient={dataClient}
        fetchImpl={fetchMock as unknown as typeof fetch}
        onCopyText={(text) => {
          copiedTexts.push(text);
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Status/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    await waitFor(() => expect(getAdminStatus).toHaveBeenCalledWith({ role: 'admin' }));
    expect(within(dialog).getByText(/1 failed · 1 blocked/i)).toBeTruthy();

    // Before clicking "Run connectivity checks", Auth & DB MUST be "Not checked",
    // Background workers MUST be "Unknown (not probed from desktop)", and fetch MUST NOT have run!
    expect(fetchMock).not.toHaveBeenCalled();
    expect(within(dialog).getAllByText(/^Not checked$/i)).toHaveLength(2);
    expect(within(dialog).getByText(/Unknown \(not probed from desktop\)/i)).toBeTruthy();
    expect(
      within(dialog).getByText(/A passing check does not prove full backend health/i),
    ).toBeTruthy();

    // Run async non-blocking connectivity checks:
    fireEvent.click(within(dialog).getByRole('button', { name: /Run connectivity checks/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findAllByText(/^Reachable$/i)).toHaveLength(2);

    // Copy sanitized diagnostics:
    fireEvent.click(within(dialog).getByRole('button', { name: /Copy diagnostics/i }));
    await waitFor(() => expect(copiedTexts).toHaveLength(1));
    expect(copiedTexts[0]).toContain('app_version: 1.1.3');
    expect(copiedTexts[0]).toContain('local_store_available: true');
    expect(copiedTexts[0]).toContain('local_store_schema_version: 4');
    expect(copiedTexts[0]).not.toMatch(/@|shahabas|amervisamedical|Bearer|C:\\|\/home\//i);

    // Escape closes dialog cleanly:
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reports unconfigured or unreachable connectivity states truthfully without throwing', async () => {
    const unconfigured = await runSupabaseConnectivityChecks({
      supabaseUrl: '',
      supabaseAnonKey: '',
    });
    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.authEndpoint.status).toBe('unconfigured');
    expect(unconfigured.databaseRlsRead.status).toBe('unconfigured');

    const offlineFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const unreachable = await runSupabaseConnectivityChecks({
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'sb_publishable_test',
      accessToken: 'jwt-token',
      fetchImpl: offlineFetch as unknown as typeof fetch,
    });
    expect(unreachable.authEndpoint.status).toBe('unreachable');
    expect(unreachable.databaseRlsRead.status).toBe('unreachable');
    expect(unreachable.backgroundWorkers.status).toBe('unknown');

    const summary = formatSanitizedDiagnosticsText({
      local: sampleLocalStatus(),
      connectivity: createInitialConnectivityReport(true),
    });
    expect(summary).toContain('supabase_auth_reachability: not_checked');
    expect(summary).toContain('backend_workers_health: unknown (not probed from desktop)');
  });

  it('exposes the Automatic error reporting disclosure and Admin-only toggle in Settings -> About & updates', () => {
    const onSettingsChange = vi.fn();
    const { rerender } = render(
      <SettingsPage
        role="admin"
        columns={[]}
        settings={{ ...DEFAULT_SETTINGS, errorReportingEnabled: true }}
        onSettingsChange={onSettingsChange}
        onSignOutAllOfficeSessions={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /About & updates/i }));
    expect(screen.getByText(/Automated error reporting/i)).toBeTruthy();

    const toggle = screen.getByRole('checkbox', {
      name: /Automatic error reporting/i,
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);

    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ errorReportingEnabled: false }),
    );

    // Office cannot access Settings or the toggle at all:
    rerender(
      <SettingsPage
        role="office"
        columns={[]}
        settings={{ ...DEFAULT_SETTINGS, errorReportingEnabled: true }}
        onSettingsChange={onSettingsChange}
        onSignOutAllOfficeSessions={vi.fn()}
      />,
    );
    expect(screen.getByText(/Settings are available to administrators only/i)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Automatic error reporting/i })).toBeNull();
  });
});
