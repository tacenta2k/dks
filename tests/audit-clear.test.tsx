import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { AdminAuditLogPanel } from '../src/features/admin/AdminTools';
import {
  AUDIT_CLEAR_CONFIRMATION,
  AUDIT_CLEAR_SQL_FILE,
  auditClearMessage,
  clearRemoteAuditLog,
  isAuditClearConfirmation,
  isMissingAuditClearFunction,
} from '../src/features/audit/audit-service';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import { createSqliteStore } from '../electron/main/sqlite';

/**
 * R2-10 — "Clear audit log" is an administrator-only action: it asks the
 * administrator to type DELETE, clears the remote log through the admin-only
 * `clear_audit_log()` RPC, clears the local mirror, then leaves exactly one
 * entry reading "Audit log cleared by Admin on <date time>".
 */

function readSql(path: string): string {
  return readFileSync(resolve(__dirname, '..', path), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('audit clear service', () => {
  it('formats the single entry and requires the exact DELETE confirmation', () => {
    expect(auditClearMessage('Admin', new Date('2026-03-04T09:05:00.000Z'))).toContain(
      'Audit log cleared by Admin on',
    );
    expect(isAuditClearConfirmation('delete')).toBe(false);
    expect(isAuditClearConfirmation(' DELETE ')).toBe(true);
    expect(AUDIT_CLEAR_CONFIRMATION).toBe('DELETE');
  });

  it('calls the admin-only RPC and surfaces server errors', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await clearRemoteAuditLog({ rpc }, 'Audit log cleared by Admin on 04/03/2026 09:05');
    expect(rpc).toHaveBeenCalledWith('clear_audit_log', {
      p_message: 'Audit log cleared by Admin on 04/03/2026 09:05',
    });

    await expect(clearRemoteAuditLog(
      { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not allowed' } }) },
      'x',
    )).rejects.toThrow('Not allowed');

    // Offline: refuse rather than clearing only the local copy.
    await expect(clearRemoteAuditLog(null, 'x')).rejects.toThrow(/only be cleared while connected/i);
  });

  it('never falls back to an unfiltered REST delete (the R3 "DELETE requires a WHERE clause" shape)', async () => {
    const deleteSpy = vi.fn();
    const client = {
      from: vi.fn(() => ({ delete: deleteSpy })),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    } as unknown as Parameters<typeof clearRemoteAuditLog>[0];

    await clearRemoteAuditLog(client, 'Audit log cleared by Admin on 04/03/2026 09:05');
    // Only the RPC is used; no table DELETE is ever built by the clear path.
    expect((client as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();

    // A client without rpc is refused rather than degraded to a bulk delete.
    await expect(clearRemoteAuditLog(
      { from: () => ({ delete: deleteSpy }) } as unknown as Parameters<typeof clearRemoteAuditLog>[0],
      'x',
    )).rejects.toThrow(/only be cleared while connected/i);
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe('audit clear SQL', () => {
  const files = ['supabase/schema.sql', 'ARENA/sql/fix-entries-rls.sql'];

  it.each(files)('%s ships an admin-only security-definer clear_audit_log()', (file) => {
    const sql = readSql(file).toLowerCase();
    expect(sql).toContain('create or replace function public.clear_audit_log');
    expect(sql).toContain('security definer');
    expect(sql).toContain("raise exception 'only administrators may clear the audit log'");
    expect(sql).toContain('grant execute on function public.clear_audit_log(text) to authenticated');
    expect(sql).not.toContain('grant execute on function public.clear_audit_log(text) to anon');
    // No tenant-wide DELETE policy may exist on the audit log itself.
    expect(sql).not.toMatch(/create policy [a-z_]+ on public\.audit_log for delete/);
    expect(sql).not.toMatch(/grant (all|delete) on (table )?public\.audit_log to (anon|authenticated)/);
  });
});

describe('local audit mirror clear', () => {
  it('removes every local entry and records exactly one clear entry', () => {
    const store = createSqliteStore({
      filename: ':memory:',
      now: () => '2026-03-04T09:05:00.000Z',
    });
    store.recordAudit({
      actor: null,
      entityType: 'entry',
      entityId: 'row-1',
      action: 'create',
      before: null,
      after: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    store.recordAudit({
      actor: null,
      entityType: 'entry',
      entityId: 'row-2',
      action: 'update',
      before: null,
      after: {},
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const message = 'Audit log cleared by Admin on 04/03/2026 09:05';
    store.clearAuditLog({ message });

    const history = store.listAudit(500);
    expect(history).toHaveLength(1);
    expect(history[0].action).toBe('clear_audit');
    expect(history[0].after).toEqual({ message });
    store.close?.();
  });

  it('clears the in-memory repository the same way', async () => {
    const repository = createInMemorySheetRepository();
    await repository.createRow({ full_name: 'A' });
    expect((await repository.getAuditHistory?.())?.length).toBeGreaterThan(0);

    const history = await repository.clearAuditLog?.('Audit log cleared by Admin on 04/03/2026 09:05');
    expect(history).toHaveLength(1);
    expect(history?.[0].action).toBe('clear_audit');
  });
});

describe('Clear audit log control', () => {
  it('is admin-only, needs DELETE typed, and clears remote before local', async () => {
    const repository = createInMemorySheetRepository();
    await repository.createRow({ full_name: 'Seed' });
    const order: string[] = [];
    const remoteClient = {
      rpc: vi.fn(async () => {
        order.push('remote');
        return { data: null, error: null };
      }),
    };
    const originalClear = repository.clearAuditLog!.bind(repository);
    const clearLocal = vi.fn(async (message: string) => {
      order.push('local');
      return originalClear(message);
    });
    repository.clearAuditLog = clearLocal;

    render(
      <AdminAuditLogPanel
        role="admin"
        actorLabel="Admin"
        repository={repository}
        remoteClient={remoteClient}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear audit log' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear audit log' });
    const confirm = within(dialog).getByRole('button', { name: 'Clear audit log' });
    expect(confirm).toBeDisabled();

    const input = screen.getByLabelText('Type DELETE to confirm');
    fireEvent.change(input, { target: { value: 'delete' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    await waitFor(() => expect(remoteClient.rpc).toHaveBeenCalledWith('clear_audit_log', {
      p_message: expect.stringContaining('Audit log cleared by Admin on'),
    }));
    await waitFor(() => expect(clearLocal).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['remote', 'local']);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Clear audit log' })).not.toBeInTheDocument());
    // One entry survives, describing the clear.
    await waitFor(() => expect(screen.getAllByText('Cleared the audit log').length).toBeGreaterThan(0));
    // The single surviving entry carries the exact human sentence.
    expect(screen.getAllByText(/Audit log cleared by Admin on/).length).toBeGreaterThan(0);
  });

  it('names the migration when the server has not got the RPC yet', async () => {
    const missing = 'Could not find the function public.clear_audit_log(p_message) in the schema cache';
    expect(isMissingAuditClearFunction(missing)).toBe(true);
    expect(isMissingAuditClearFunction('Only administrators may clear the audit log')).toBe(false);

    await expect(clearRemoteAuditLog(
      { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: missing } }) },
      'x',
    )).rejects.toThrow(new RegExp(AUDIT_CLEAR_SQL_FILE.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')));
  });

  it('reports the server refusal verbatim and promises nothing was removed', async () => {
    await expect(clearRemoteAuditLog(
      { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'Only administrators may clear the audit log' } }) },
      'x',
    )).rejects.toThrow(/Only administrators may clear the audit log.*Nothing was removed/s);
  });

  it('keeps the local mirror when the remote clear fails', async () => {
    const repository = createInMemorySheetRepository();
    await repository.createRow({ full_name: 'Keep me' });
    const before = await repository.getAuditHistory?.();
    const clearLocal = vi.fn();
    repository.clearAuditLog = clearLocal;

    render(
      <AdminAuditLogPanel
        role="admin"
        actorLabel="Admin"
        repository={repository}
        remoteClient={{ rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'Only administrators may clear the audit log' } }) }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear audit log' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear audit log' });
    fireEvent.change(within(dialog).getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear audit log' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Only administrators/));
    expect(clearLocal).not.toHaveBeenCalled();
    expect(await repository.getAuditHistory?.()).toHaveLength(before?.length ?? 0);
  });

  it('never renders for Office', () => {
    const repository = createInMemorySheetRepository();
    render(<AdminAuditLogPanel role="office" repository={repository} />);
    expect(screen.queryByRole('button', { name: 'Clear audit log' })).not.toBeInTheDocument();
  });
});
