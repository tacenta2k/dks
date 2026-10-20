import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

import { AuditLogPage } from '../src/features/audit/AuditLogPage';
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
];

describe('audit log page', () => {
  it('displays action, actor, time, and details for administrators', () => {
    render(<AuditLogPage role="admin" entries={entries} />);

    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
    expect(screen.getByText('import')).toBeInTheDocument();
    expect(screen.getByText('Admin User')).toBeInTheDocument();
    expect(screen.getByText(/rows\.csv/)).toBeInTheDocument();
    expect(screen.getByText('2026-01-01T12:00:00.000Z')).toBeInTheDocument();
  });

  it('shows an administrator gate to office users', () => {
    render(<AuditLogPage role="office" entries={entries} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/administrator/i);
    expect(screen.queryByRole('heading', { name: 'Audit log' })).not.toBeInTheDocument();
  });
});
