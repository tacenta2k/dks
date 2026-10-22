import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { RecycleBinPage } from '../src/features/recycle-bin/RecycleBinPage';
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

    expect(screen.getByRole('heading', { name: 'Recycle bin' })).toBeInTheDocument();
    expect(screen.getAllByText('Deleted record').length).toBeGreaterThan(0);
    expect(screen.queryByText('Active record')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Deleted record' }));
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete Deleted record' }));
    expect(onRestore).toHaveBeenCalledWith(rows[0]);
    expect(onPermanentDelete).toHaveBeenCalledWith(rows[0]);
  });

  it('shows an administrator gate to office users', () => {
    render(<RecycleBinPage role="office" rows={rows} columns={columns} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/administrator/i);
    expect(screen.queryByRole('button', { name: /Restore/i })).not.toBeInTheDocument();
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
