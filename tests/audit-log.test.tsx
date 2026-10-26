import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

import {
  AuditLogPage,
  entryActor,
  formatAuditAction,
  formatAuditFieldLines,
  formatAuditTime,
  summarizeAuditDetails,
} from '../src/features/audit/AuditLogPage';
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
    // Readable details in the table; raw JSON is not part of the normal view.
    expect(table.getAllByText(/rows\.csv/).length).toBeGreaterThan(0);
    expect(table.queryByText('Show raw JSON')).not.toBeInTheDocument();
    expect(table.queryByText(/"rowId"/)).not.toBeInTheDocument();
    expect(table.queryByText(/"importedRows"/)).not.toBeInTheDocument();
    // The import event reads as labelled fields, not a JSON blob.
    expect(table.getByText(/Imported records: 4/)).toBeInTheDocument();
    // An unresolved record id falls back to words, never the raw value.
    expect(table.getAllByText(/Record: Record no longer available/).length).toBeGreaterThanOrEqual(1);
  });

  it('shows field-level changes in the details panel with technical details collapsed', () => {
    const changed: AuditEntry[] = [{
      id: 'audit-change',
      action: 'update_entry',
      actor: 'Admin User',
      timestamp: '2026-01-05T10:00:00.000Z',
      entityType: 'entry',
      entityId: 'row-9',
      details: {
        before: { data: { name: 'Old Name', status: 'Pending' }, category: 'Employee', deleted: false },
        after: { data: { name: 'New Name', status: 'Approved' }, category: 'Employee', deleted: false },
      },
    }];
    render(
      <AuditLogPage
        role="admin"
        entries={changed}
        columns={[
          { id: 'name', name: 'Full Name', type: 'text' },
          { id: 'status', name: 'Status', type: 'text' },
        ]}
        rows={[{ id: 'row-9', data: { name: 'New Name' } }]}
      />,
    );

    const table = within(screen.getByRole('table'));
    // Table summary is the readable diff, with the record resolved by name.
    expect(table.getByText(/Record: New Name/)).toBeInTheDocument();
    expect(table.getByText(/Status: Pending → Approved/)).toBeInTheDocument();
    expect(table.queryByText('Show raw JSON')).not.toBeInTheDocument();

    fireEvent.click(table.getByRole('button', { name: 'View' }));
    const panel = screen.getByLabelText('Event details');
    expect(within(panel).getByText('Full Name')).toBeInTheDocument();
    expect(within(panel).getByText('Old Name → New Name')).toBeInTheDocument();
    expect(within(panel).getByText('Pending → Approved')).toBeInTheDocument();
    // Unchanged fields are omitted from the diff.
    expect(within(panel).queryByText('Category')).not.toBeInTheDocument();
    // Sanitized technical JSON exists only here, collapsed, for admins.
    const technical = within(panel).getByText('Technical details');
    expect(technical.closest('details')).not.toHaveAttribute('open');
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

  it('diffs real before/after snapshots into readable field transitions', () => {
    const columns = [
      { id: 'name', name: 'Full Name', type: 'text' as const },
      { id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry' as const },
      { id: 'notes', name: 'Notes', type: 'notes' as const },
    ];
    const lines = formatAuditFieldLines({
      before: {
        data: { name: 'Ada Lovelace', visa_expiry: '2026-01-01', notes: 'Old note' },
        category: 'Employee',
        deleted: false,
      },
      after: {
        data: { name: 'Ada Lovelace', visa_expiry: '2027-01-01' },
        category: 'Employee',
        deleted: true,
      },
    }, { columns });

    // Dates display DD/MM/YYYY; a removed field ends at —; the deleted flag
    // reads as a record state; unchanged name/category are omitted.
    expect(lines).toEqual([
      { field: 'Visa Expiry', text: '01/01/2026 → 01/01/2027' },
      { field: 'Notes', text: 'Old note → —' },
      { field: 'Record state', text: 'Active → In Recycle Bin' },
    ]);
  });

  it('shows added fields from a null before snapshot and resolves column order ids', () => {
    const created = formatAuditFieldLines({
      before: null,
      after: { name: 'Passport No', type: 'text' },
    });
    expect(created).toEqual([
      { field: 'Name', text: '— → Passport No' },
      { field: 'Type', text: '— → text' },
    ]);

    const reordered = formatAuditFieldLines({
      before: { order: ['name', 'visa_expiry'] },
      after: { order: ['visa_expiry', 'name'] },
    }, {
      columns: [
        { id: 'name', name: 'Full Name', type: 'text' },
        { id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry' },
      ],
    });
    expect(reordered).toEqual([
      { field: 'Column order', text: 'Full Name, Visa Expiry → Visa Expiry, Full Name' },
    ]);
  });

  it('summarizes without JSON, truncates long values, and hides sensitive fields', () => {
    const summary = summarizeAuditDetails({
      message: 'x'.repeat(400),
      accessToken: 'should-never-appear',
      nested: { inner: { deep: 'value' } },
    });
    expect(summary).not.toContain('{');
    expect(summary).not.toContain('should-never-appear');
    expect(summary.length).toBeLessThanOrEqual(320);
    expect(summary).toContain('Hidden');

    const lines = formatAuditFieldLines({ notes: 'y'.repeat(300) });
    expect(lines[0].text.length).toBeLessThanOrEqual(120);
    expect(lines[0].text.endsWith('…')).toBe(true);

    expect(summarizeAuditDetails(null)).toBe('No details recorded.');
    expect(summarizeAuditDetails({
      before: { data: { a: '1', b: '2', c: '3', d: '4' } },
      after: { data: { a: '9', b: '8', c: '7', d: '6' } },
    })).toContain('+1 more');
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
