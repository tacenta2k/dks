import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import {
  buildPrintReportModel,
  exportReportToPdf,
  REPORT_FILTERS,
} from '../src/features/print/print-service';
import { PrintReportModal } from '../src/features/print/PrintReportModal';
import type { ColumnDefinition } from '../src/lib/columns';
import type { SheetRow } from '../src/features/sheet/types';

const columns: ColumnDefinition[] = [
  { id: 'name', name: 'Name', type: 'text', position: 0 },
  { id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', position: 1 },
  { id: 'notes', name: 'Notes', type: 'notes', position: 2 },
];

const rows: SheetRow[] = [
  { id: 'expired', data: { name: 'Expired', visa_expiry: '2025-12-31', notes: 'old' } },
  { id: 'today', data: { name: 'Today', visa_expiry: '2026-01-01', notes: 'now' } },
  { id: 'week', data: { name: 'Week', visa_expiry: '2026-01-04', notes: 'soon' } },
  { id: 'month', data: { name: 'Month', visa_expiry: '2026-01-20', notes: 'later' } },
  { id: 'year', data: { name: 'Year', visa_expiry: '2026-12-31', notes: 'far' } },
];

describe('print and report workflows', () => {
  it('offers the required report filters and sorts matching rows by Days Left ascending', () => {
    expect(REPORT_FILTERS.map((filter) => filter.id)).toEqual([
      'today', 'week', 'month', '2-months', '3-months', '6-months', '1-year', 'expired', 'all',
    ]);

    const model = buildPrintReportModel(rows, columns, {
      role: 'admin',
      filter: 'month',
      today: '2026-01-01',
      selectedColumnIds: ['name', 'visa_expiry'],
      generatedAt: '2026-01-01T12:00:00.000Z',
    });

    expect(model.filterSummary).toBe('Expiring within 1 month');
    expect(model.columns.map((column) => column.name)).toEqual(['Name', 'Visa Expiry', 'Days Left']);
    expect(model.rows.map((row) => row.id)).toEqual(['today', 'week', 'month']);
    expect(model.rows.map((row) => row.daysLeft)).toEqual([0, 3, 19]);
    expect(model.page.pageCount).toBe(1);
  });

  it('renders a report modal with a column picker and delegates print and PDF actions', () => {
    const model = buildPrintReportModel(rows, columns, {
      role: 'admin',
      filter: 'all',
      today: '2026-01-01',
    });
    const onPrint = vi.fn();
    const onExportPdf = vi.fn();
    render(
      <PrintReportModal
        open
        model={model}
        role="admin"
        onClose={vi.fn()}
        onPrint={onPrint}
        onExportPdf={onExportPdf}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Print report' })).toBeInTheDocument();
    expect(screen.getByLabelText('Report columns')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Notes' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Print report' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    expect(onPrint).toHaveBeenCalledWith(model);
    expect(onExportPdf).toHaveBeenCalledWith(model);
  });

  it('renders an administrator gate before building report data for office users', () => {
    render(
      <PrintReportModal
        open
        role="office"
        rows={rows}
        columns={columns}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/administrator/i);
    expect(screen.queryByRole('dialog', { name: 'Print report' })).not.toBeInTheDocument();
  });

  it('creates PDF bytes through the injectable save callback and rejects office PDF export', async () => {
    const model = buildPrintReportModel(rows, columns, { role: 'admin', today: '2026-01-01' });
    const save = vi.fn();
    const result = await exportReportToPdf(model, {
      role: 'admin',
      fileName: 'report.pdf',
      save,
    });

    expect(result.fileName).toBe('report.pdf');
    expect(result.data.byteLength).toBeGreaterThan(0);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'report.pdf' }));
    // The permission check runs before the lazy PDF import, so Office is
    // refused without downloading the library.
    await expect(exportReportToPdf(model, { role: 'office' })).rejects.toThrow(/administrator/i);
  });
});
