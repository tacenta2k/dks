import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { RecycleBinPage } from '../src/features/recycle-bin/RecycleBinPage';
import { AdminRecycleBinPanel } from '../src/features/admin/AdminTools';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import type { ColumnDefinition } from '../src/lib/columns';
import type { SheetRow } from '../src/features/sheet/types';

const columns: ColumnDefinition[] = [
  { id: 'name', name: 'Name', type: 'text', position: 0 },
];

const rows: SheetRow[] = [
  { id: 'deleted-1', data: { name: 'Deleted record' }, deleted: true, updatedAt: '2026-01-01T10:00:00.000Z' },
  { id: 'active-1', data: { name: 'Active record' }, deleted: false },
];

describe('recycle bin page', () => {
  it('lists deleted rows for admins and delegates restore and permanent delete', () => {
    const onRestore = vi.fn();
    const onPermanentDelete = vi.fn();
    render(
      <RecycleBinPage
        role="admin"
        rows={rows}
        columns={columns}
        onRestore={onRestore}
        onPermanentDelete={onPermanentDelete}
      />,
    );

    // FIXES_UI §7: the page title lives in the top bar (App level), so the
    // panel no longer renders its own heading — assert on the deleted rows.
    expect(screen.getAllByText('Deleted record').length).toBeGreaterThan(0);
    expect(screen.queryByText('Active record')).not.toBeInTheDocument();
    // Buttons say only Restore / Delete — no record name or ID appended, with
    // distinct semantic positive/destructive styling.
    const restoreButton = screen.getByRole('button', { name: 'Restore' });
    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    expect(restoreButton).toHaveClass('recycle-bin-action', 'recycle-bin-action--restore');
    expect(deleteButton).toHaveClass('recycle-bin-action', 'recycle-bin-action--delete');
    fireEvent.click(restoreButton);
    fireEvent.click(deleteButton);
    expect(onRestore).toHaveBeenCalledWith(rows[0]);
    expect(onPermanentDelete).toHaveBeenCalledWith(rows[0]);

    const shellCss = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
    expect(shellCss).toContain('.recycle-bin-action--restore');
    expect(shellCss).toContain('.recycle-bin-action--delete');
    expect(shellCss).toContain(":root[data-theme='dark'] .recycle-bin-action--restore");
    expect(shellCss).toContain(":root[data-theme='dark'] .recycle-bin-action--delete");
  });

  it('shows an administrator gate to office users', () => {
    render(<RecycleBinPage role="office" rows={rows} columns={columns} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/administrator/i);
    expect(screen.queryByRole('button', { name: /Restore/i })).not.toBeInTheDocument();
    // Office must never see the bulk-delete control either.
    expect(screen.queryByRole('button', { name: 'Delete all' })).not.toBeInTheDocument();
  });

  it('shows just the live item count and an Admin-only Delete all action', () => {
    const onDeleteAll = vi.fn();
    render(
      <RecycleBinPage
        role="admin"
        rows={rows}
        columns={columns}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
        onDeleteAll={onDeleteAll}
      />,
    );

    // One deleted row in this fixture: the retention clause is gone.
    expect(screen.getByTestId('recycle-bin-count')).toHaveTextContent('1 item');
    expect(screen.queryByText(/kept until permanently deleted/i)).not.toBeInTheDocument();

    const deleteAll = screen.getByRole('button', { name: 'Delete all' });
    fireEvent.click(deleteAll);
    expect(onDeleteAll).toHaveBeenCalledTimes(1);
  });

  it('updates the count with the active search filter', () => {
    render(
      <RecycleBinPage
        role="admin"
        rows={[
          { id: 'deleted-1', data: { name: 'Ahmed' }, deleted: true },
          { id: 'deleted-2', data: { name: 'Fatima' }, deleted: true },
        ]}
        columns={columns}
        onDeleteAll={vi.fn()}
      />,
    );

    expect(screen.getByTestId('recycle-bin-count')).toHaveTextContent('2 items');
    fireEvent.change(screen.getByLabelText('Search deleted records'), { target: { value: 'ahmed' } });
    expect(screen.getByTestId('recycle-bin-count')).toHaveTextContent('1 item');
  });

  it('hides the toolbar and Delete all action when the bin is empty', () => {
    render(
      <RecycleBinPage role="admin" rows={[{ id: 'active-1', data: { name: 'Active' }, deleted: false }]} columns={columns} onDeleteAll={vi.fn()} />,
    );

    expect(screen.getByText('Recycle Bin is empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete all' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Search deleted records')).not.toBeInTheDocument();
  });

  it('omits Delete all when no host handler is supplied', () => {
    render(<RecycleBinPage role="admin" rows={rows} columns={columns} />);
    expect(screen.queryByRole('button', { name: 'Delete all' })).not.toBeInTheDocument();
  });

  it('shows human labels, local DD/MM/YYYY HH:mm deletion time and who deleted (S2)', () => {
    render(
      <RecycleBinPage
        role="admin"
        rows={[
          {
            id: 'row-7ce65046-aaaa-bbbb-cccc-000000000000',
            data: { name: 'Ahmed', passport_no: 'A1234567' },
            deleted: true,
            deletedAt: '2026-01-02T09:30:00.000Z',
            updatedBy: 'Ahmed K',
          },
          {
            id: 'row-02b75364-aaaa-bbbb-cccc-000000000000',
            data: {},
            deleted: true,
            deletedAt: '2026-01-03T10:00:00.000Z',
          },
        ]}
        columns={[{ id: 'name', name: 'Name', type: 'text' }]}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
      />,
    );

    // Human label — never a raw row id.
    expect(screen.getAllByText('Ahmed').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Unnamed record')).toBeInTheDocument();
    expect(screen.queryByText(/row-7ce65046/)).not.toBeInTheDocument();
    expect(screen.queryByText(/row-02b75364/)).not.toBeInTheDocument();
    // Local DD/MM/YYYY HH:mm (never the raw ISO value).
    expect(screen.getAllByText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/).length).toBe(2);
    expect(screen.queryByText('2026-01-02T09:30:00.000Z')).not.toBeInTheDocument();
    // Who deleted it, when that information exists.
    expect(screen.getByText('Ahmed K')).toBeInTheDocument();
  });
});

describe('Recycle Bin Delete all (AdminRecycleBinPanel)', () => {
  it('gates on typed DELETE, cancels without changes, then deletes every row through the permanent-delete path', async () => {
    const repository = createInMemorySheetRepository();
    await repository.addColumn({ name: 'Name', type: 'text' });
    const first = await repository.createRow({ name: 'Ahmed' });
    const second = await repository.createRow({ name: 'Fatima' });
    await repository.softDeleteRow(first.id);
    await repository.softDeleteRow(second.id);

    render(
      <AdminRecycleBinPanel
        repository={repository}
        role="admin"
        actor={{ id: 'admin-1', name: 'Admin' }}
      />,
    );

    // The record label and the Name column cell both show the value.
    expect((await screen.findAllByText('Ahmed')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete all records in the Recycle Bin?' });
    expect(within(dialog).getByText(/permanently deletes ALL 2 records/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Delete all permanently' });
    const input = within(dialog).getByLabelText('Type DELETE to confirm');
    expect(confirm).toBeDisabled();

    // The gate is exact: lowercase stays disabled.
    fireEvent.change(input, { target: { value: 'delete' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect(confirm).toBeEnabled();

    // Cancel performs no deletion and closes the dialog.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect((await repository.getRows()).filter((row) => row.deleted === true)).toHaveLength(2);

    // Reopen: the typed gate starts empty again.
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));
    const reopened = await screen.findByRole('dialog', { name: 'Delete all records in the Recycle Bin?' });
    const reopenedInput = within(reopened).getByLabelText('Type DELETE to confirm') as HTMLInputElement;
    expect(reopenedInput).toHaveValue('');
    fireEvent.change(reopenedInput, { target: { value: 'DELETE' } });
    fireEvent.click(within(reopened).getByRole('button', { name: 'Delete all permanently' }));

    await waitFor(async () => {
      const deletedRows = (await repository.getRows()).filter((row) => row.deleted === true);
      expect(deletedRows).toHaveLength(0);
    });
    expect(await screen.findByText('Recycle Bin is empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete all' })).not.toBeInTheDocument();

    // One permanent_delete audit entry per row — identical semantics to the
    // single-row delete path.
    const audit = await repository.getAuditHistory?.();
    expect(audit?.filter((entry) => entry.action === 'permanent_delete')).toHaveLength(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
