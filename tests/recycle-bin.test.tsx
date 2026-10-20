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
});
