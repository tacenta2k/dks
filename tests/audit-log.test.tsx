import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

import { AuditLogPage, entryActor, formatAuditAction, formatAuditTime } from '../src/features/audit/AuditLogPage';
import type { AuditEntry } from '../src/features/audit/audit-types';

const entries: AuditEntry[] = [
  {
    id: 'audit-1',
    action: 'import',
    actorId: 'user-1',
    actor: 'Admin User',
    timestamp: '2026-01-01T12:00:00.000Z',
    details: { importedRows: 4, fileName: 'rows.csv' },
  },
  {
    id: 'audit-2',
    action: 'soft_delete',
    actorId: '846536af-f3c6-47c1-8559-d13442c1490a',
    actor: null,
    timestamp: '2026-01-02T09:30:00.000Z',
    details: { rowId: 'row-7ce65046-aaaa-bbbb-cccc-000000000000' },
  },
  {
    id: 'audit-3',
    action: 'permanent_delete',
    actorId: '33333333-3333-3333-3333-333333333333',
    actor: '33333333-3333-3333-3333-333333333333',
    timestamp: '2026-01-03T09:30:00.000Z',
    details: { rowId: 'row-1' },
  },
];

const profiles = [
  { id: '846536af-f3c6-47c1-8559-d13442c1490a', full_name: 'Ahmed K', email: 'ahmed@example.com', role: 'admin' },
  { id: '33333333-3333-3333-3333-333333333333', email: 'office@example.com', role: 'office' },
];

describe('audit log page', () => {
  it('displays friendly actions, real actors, local time, and details (S3)', () => {
    render(<AuditLogPage role="admin" entries={entries} profiles={profiles} />);

    // FIXES_UI §8: the page title lives in the top bar (App level), so the
    // panel no longer renders its own heading — assert on the table content.
    const table = within(screen.getByRole('table'));
    // Friendly action names, never raw codes.
    expect(table.getByText('Imported records')).toBeInTheDocument();
    expect(table.getByText('Moved to Recycle Bin')).toBeInTheDocument();
    expect(table.getByText('Permanently deleted')).toBeInTheDocument();
    // Actor recorded directly.
    expect(table.getByText('Admin User')).toBeInTheDocument();
    // Actor resolved from the profiles join — never "Unknown" or a raw UUID.
    expect(table.getByText('Ahmed K')).toBeInTheDocument();
    expect(table.queryByText('Unknown')).not.toBeInTheDocument();
    expect(table.queryByText(/846536af-f3c6-47c1-8559-d13442c1490a/)).not.toBeInTheDocument();
    // Office is a shared account — never implies an individual person.
    expect(table.getByText('Office (shared account)')).toBeInTheDocument();
    expect(table.queryByText('office@example.com')).not.toBeInTheDocument();
    // Local DD/MM/YYYY HH:mm display, ISO kept in dateTime.
    const time = table.getAllByText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(time.length).toBeGreaterThanOrEqual(3);
    expect(table.queryByText('2026-01-01T12:00:00.000Z')).not.toBeInTheDocument();
    // Readable details with raw JSON on demand.
    expect(table.getAllByText(/rows\.csv/).length).toBeGreaterThan(0);
    expect(table.getAllByText('Show raw JSON').length).toBeGreaterThanOrEqual(1);
  });

  it('filters by action, actor, and date range (S3)', () => {
    render(<AuditLogPage role="admin" entries={entries} profiles={profiles} />);

    fireEvent.change(screen.getByLabelText('Filter by action'), { target: { value: 'Moved to Recycle Bin' } });
    let table = within(screen.getByRole('table'));
    expect(table.getByText('Moved to Recycle Bin')).toBeInTheDocument();
    expect(table.queryByText('Imported records')).not.toBeInTheDocument();
    expect(table.queryByText('Permanently deleted')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by action'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Filter by actor'), { target: { value: 'Ahmed K' } });
    table = within(screen.getByRole('table'));
    expect(table.getByText('Moved to Recycle Bin')).toBeInTheDocument();
    expect(table.queryByText('Imported records')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by actor'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Filter from date'), { target: { value: '2026-01-03' } });
    table = within(screen.getByRole('table'));
    expect(table.getByText('Permanently deleted')).toBeInTheDocument();
    expect(table.queryByText('Imported records')).not.toBeInTheDocument();
  });

  it('never shows Unknown or a raw user id even without a profiles join', () => {
    const noActor: AuditEntry[] = [{
      id: 'audit-x',
      action: 'restore',
      actorId: null,
      actor: null,
      timestamp: '2026-01-04T10:00:00.000Z',
      details: null,
    }];
    render(<AuditLogPage role="admin" entries={noActor} />);
    const table = within(screen.getByRole('table'));

    expect(table.queryByText('Unknown')).not.toBeInTheDocument();
    expect(table.getByText('System (local action)')).toBeInTheDocument();
    expect(table.getByText('Restored record')).toBeInTheDocument();
  });

  it('shows an administrator gate to office users', () => {
    render(<AuditLogPage role="office" entries={entries} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/administrator/i);
    expect(screen.queryByRole('heading', { name: 'Audit log' })).not.toBeInTheDocument();
  });

  it('format helpers keep S3 promises', () => {
    expect(formatAuditAction('soft_delete')).toBe('Moved to Recycle Bin');
    expect(formatAuditAction('permanent_delete')).toBe('Permanently deleted');
    expect(formatAuditAction('some_new_action')).toBe('Some new action');
    expect(formatAuditTime({ action: 'x', timestamp: '2026-01-01T12:00:00.000Z' })).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(entryActor({ action: 'x', actorId: 'unknown-id', actor: null })).toBe('System (local action)');
    expect(entryActor({ action: 'x', actor: '846536af-f3c6-47c1-8559-d13442c1490a', actorId: '846536af-f3c6-47c1-8559-d13442c1490a' }, profiles)).toBe('Ahmed K');
  });
});
