import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../src/renderer/components/AppShell';
import { createInMemorySheetRepository } from '../src/features/sheet/repository';
import type { ExportArtifact } from '../src/features/import-export/export-service';
import type { PdfExportFile, PrintReportModel } from '../src/features/print/print-service';

function adminProfile() {
  return {
    id: 'admin-1',
    email: 'admin@dks.test',
    role: 'admin' as const,
    fullName: 'Admin User',
  };
}

function officeProfile() {
  return {
    id: 'office-1',
    email: 'office@dks.test',
    role: 'office' as const,
    fullName: 'Office User',
  };
}

async function seededRepository() {
  const repository = createInMemorySheetRepository();
  await repository.loadTemplate('visa');
  await repository.createRow({
    name: 'Ada Lovelace',
    passport_no: 'A-1',
    visa_expiry: '2099-01-02',
  });
  return repository;
}

describe('admin renderer integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
    Object.defineProperty(window, 'print', { configurable: true, value: vi.fn() });
  });

  it('shows recycle bin and audit log navigation only to administrators', () => {
    const onNavigate = vi.fn();
    const { rerender } = render(
      <AppShell profile={adminProfile()} onNavigate={onNavigate} />,
    );

    expect(screen.getByRole('button', { name: 'Open Recycle Bin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Audit Log' })).toBeInTheDocument();

    rerender(<AppShell profile={officeProfile()} onNavigate={onNavigate} />);
    expect(screen.queryByRole('button', { name: 'Open Recycle Bin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Audit Log' })).not.toBeInTheDocument();
  });

  it('exports current rows as CSV and Excel through the injectable save callback', async () => {
    const repository = await seededRepository();
    const saved: ExportArtifact[] = [];
    render(
      <AppShell
        activeView="sheet"
        profile={adminProfile()}
        sheetRepository={repository}
        onSaveExport={(artifact) => saved.push(artifact)}
      />,
    );

    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export Excel' }));

    await waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[0]).toEqual(expect.objectContaining({ fileName: 'dks-export.csv', rowCount: 1 }));
    expect(saved[1]).toEqual(expect.objectContaining({ fileName: 'dks-export.xlsx', rowCount: 1 }));
  }, 15_000);

  it('previews and imports mapped file rows into the repository', async () => {
    const repository = await seededRepository();
    render(
      <AppShell activeView="sheet" profile={adminProfile()} sheetRepository={repository} />,
    );

    await screen.findByText('Ada Lovelace');
    const input = screen.getByLabelText('Import CSV or Excel file');
    const file = new File(['Name,Passport No\nGrace Hopper,G-2'], 'people.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });
    expect((input as HTMLInputElement).files?.[0]?.name).toBe('people.csv');

    expect(await screen.findByRole('dialog', { name: 'Import preview' })).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import mapped records' }));

    await waitFor(async () => {
      expect((await repository.getRows()).some((row) => row.data.name === 'Grace Hopper')).toBe(true);
    });
  });

  it('delegates print and PDF report actions from the report modal', async () => {
    const repository = await seededRepository();
    const onPrint = vi.fn<(model: PrintReportModel) => void>();
    const onSavePdf = vi.fn<(file: PdfExportFile) => void>();
    render(
      <AppShell
        activeView="sheet"
        profile={adminProfile()}
        sheetRepository={repository}
        onPrint={onPrint}
        onSavePdf={onSavePdf}
      />,
    );

    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(screen.getByRole('dialog', { name: 'Print report' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Print report' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));

    await waitFor(() => {
      expect(onPrint).toHaveBeenCalledWith(expect.objectContaining({ header: 'DKS Expiry Report' }));
      expect(onSavePdf).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'dks-report.pdf' }));
    });
  });

  it('lists deleted rows and confirms restore and permanent delete actions', async () => {
    const repository = await seededRepository();
    const row = (await repository.getRows())[0];
    await repository.softDeleteRow(row.id);
    render(
      <AppShell activeView="sheet" profile={adminProfile()} sheetRepository={repository} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Recycle Bin' }));
    expect(await screen.findByRole('heading', { name: 'Recycle bin' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Restore Ada Lovelace/i }));
    await waitFor(async () => {
      expect((await repository.getRows()).find((candidate) => candidate.id === row.id)?.deleted).toBe(false);
    });

    await repository.softDeleteRow(row.id);
    fireEvent.click(screen.getByRole('button', { name: 'Open Recycle Bin' }));
    fireEvent.click(await screen.findByRole('button', { name: /Permanently delete Ada Lovelace/i }));
    await waitFor(async () => {
      expect((await repository.getRows()).find((candidate) => candidate.id === row.id)).toBeUndefined();
    });
    expect(window.confirm).toHaveBeenCalled();
  });

  it('lists repository audit history for administrators', async () => {
    const repository = await seededRepository();
    render(<AppShell profile={adminProfile()} sheetRepository={repository} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Audit Log' }));
    expect(await screen.findByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
    expect(screen.getByText('create')).toBeInTheDocument();
  });
});
