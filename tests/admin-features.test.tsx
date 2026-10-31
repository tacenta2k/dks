import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../src/renderer/components/AppShell';
import { AdminSheetActions } from '../src/features/admin';
import { createInMemorySheetRepository, type SheetRepository } from '../src/features/sheet/repository';
import { seedFixtureColumns } from './fixtures/sheet-columns';
import type { CsvExportArtifact, ExportArtifact } from '../src/features/import-export/export-service';
import type { PdfExportFile, PrintReportModel } from '../src/features/print/print-service';

/**
 * Open the Admin "Tools ▾" menu.
 *
 * The menu is state-driven: a click on the button toggles it. A
 * `fireEvent.click` on a detached button (React replaced the node during a
 * re-render) is silently dropped, which used to surface as a mysterious
 * timeout on `findByRole('menuitem')`. This therefore (1) waits until the
 * button is enabled, (2) only clicks when the menu is actually closed, so it
 * can never toggle a menu shut, and (3) re-clicks if the menu did not open.
 */
async function openToolsMenu() {
  await waitFor(() => {
    const button = screen.getByRole('button', { name: /^Tools/ }) as HTMLButtonElement;
    expect(button).toBeEnabled();
    if (!screen.queryByRole('menu')) {
      fireEvent.click(button);
    }
    expect(screen.queryByRole('menu')).toBeInTheDocument();
  });
  return screen.getByRole('menu');
}

/** Click an item of an open menu and wait for the menu to close. */
async function chooseMenuItem(menu: HTMLElement, label: string) {
  fireEvent.click(within(menu).getByRole('menuitem', { name: label }));
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
}

/** Open the menu and click an item in one step. */
async function clickMenuItem(label: string) {
  await chooseMenuItem(await openToolsMenu(), label);
}

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
  await seedFixtureColumns(repository);
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

    expect(screen.getByRole('button', { name: 'Recycle Bin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Audit Log' })).toBeInTheDocument();

    rerender(<AppShell profile={officeProfile()} onNavigate={onNavigate} />);
    expect(screen.queryByRole('button', { name: 'Recycle Bin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Audit Log' })).not.toBeInTheDocument();
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
    // R2-09: Import / Export CSV / Export Excel / Print live in the compact
    // Admin-only "Tools ▾" toolbar menu (no Administrator Tools card).
    expect(screen.queryByText(/administrator tools/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/manage records/i)).not.toBeInTheDocument();
    // The Tools menu is its own lazy chunk, so wait for it to mount.
    expect(await screen.findByRole('button', { name: /^Tools/ })).toBeInTheDocument();

    const toolsMenu = await openToolsMenu();
    expect(within(toolsMenu).getByText(/exported files contain sensitive data/i)).toBeInTheDocument();
    await chooseMenuItem(toolsMenu, 'Export CSV');

    // R7: the toolbar waits for its own snapshot before exporting, so the save
    // happens asynchronously. The button also disables itself while the export
    // runs (Excel loads its chunk first), and a click on a busy button is
    // dropped — so wait for the save AND for it to re-enable before reopening.
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual(expect.objectContaining({ fileName: 'dks-export.csv', rowCount: 1 }));
  }, 30_000);

  // The second export used to run in the same test as the first, sharing one
  // 15 s budget. On the Windows runner the two lazy chunk loads together
  // sometimes exceeded it, and the failure said only "Test timed out" — with
  // no way to tell which export stalled. Each export now has its own budget
  // and its own assertion, so a flake names the export that stalled.
  it('exports the current rows as Excel after a CSV export', async () => {
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
    await screen.findByRole('button', { name: /^Tools/ });

    await clickMenuItem('Export CSV');
    await waitFor(() => expect(saved).toHaveLength(1));

    // The toolbar disables itself while exporting; the helper waits for it.
    await clickMenuItem('Export Excel');
    await waitFor(() => expect(saved).toHaveLength(2));

    expect(saved[0]).toEqual(expect.objectContaining({ fileName: 'dks-export.csv', rowCount: 1 }));
    expect(saved[1]).toEqual(expect.objectContaining({ fileName: 'dks-export.xlsx', rowCount: 1 }));
  }, 30_000);

  it('waits for the toolbar snapshot before exporting (R7 regression)', async () => {
    const repository = await seededRepository();
    // Hold the toolbar's own getRows/getColumns read so the click happens while
    // the snapshot is still loading — the exact race that produced an empty
    // "0 rows, Days Left only" artifact on Windows.
    let releaseSnapshot: () => void = () => undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const delayed = Object.create(repository) as SheetRepository;
    delayed.getRows = async () => {
      await snapshotGate;
      return repository.getRows();
    };
    delayed.getColumns = async () => {
      await snapshotGate;
      return repository.getColumns();
    };

    const saved: ExportArtifact[] = [];
    render(
      <AdminSheetActions
        repository={delayed}
        role="admin"
        actor={{ id: 'admin-1', name: 'Admin User', email: 'admin@dks.test' }}
        onSaveExport={(artifact) => saved.push(artifact)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Tools/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export CSV' }));

    // Nothing may be written while the rows/columns are still loading.
    expect(saved).toHaveLength(0);

    releaseSnapshot();

    await waitFor(() => expect(saved).toHaveLength(1));
    const artifact = saved[0] as CsvExportArtifact;
    expect(artifact).toEqual(expect.objectContaining({ fileName: 'dks-export.csv', rowCount: 1 }));
    // The exported snapshot is the real one, not the empty pre-load state.
    expect(artifact.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['Name', 'Days Left']),
    );
    expect(artifact.data).toContain('Ada Lovelace');
  });

  it('previews and imports mapped file rows into the repository', async () => {
    const repository = await seededRepository();
    render(
      <AppShell activeView="sheet" profile={adminProfile()} sheetRepository={repository} />,
    );

    await screen.findByText('Ada Lovelace');
    // The Tools menu (and its file input) is its own lazy chunk, so it can
    // still be in flight when the sheet rows have already painted.
    const input = await screen.findByLabelText('Import CSV or Excel file');
    const file = new File(['Name,Passport No\nGrace Hopper,G-2'], 'people.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });
    expect((input as HTMLInputElement).files?.[0]?.name).toBe('people.csv');

    expect(await screen.findByRole('dialog', { name: 'Import preview' })).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import mapped records' }));

    await waitFor(async () => {
      expect((await repository.getRows()).some((row) => row.data.name === 'Grace Hopper')).toBe(true);
    });
  }, 30_000);

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
    fireEvent.click(await screen.findByRole('button', { name: /^Tools/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Print / PDF report' }));
    // R7: the report opens once the toolbar snapshot is loaded.
    expect(await screen.findByRole('dialog', { name: 'Print report' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Print report' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));

    await waitFor(() => {
      expect(onPrint).toHaveBeenCalledWith(expect.objectContaining({ header: 'DKS Expiry Report' }));
      expect(onSavePdf).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'dks-report.pdf' }));
    });
  }, 30_000);

  it('lists deleted rows and confirms restore and permanent delete actions', async () => {
    const repository = await seededRepository();
    const row = (await repository.getRows())[0];
    await repository.softDeleteRow(row.id);
    render(
      <AppShell activeView="sheet" profile={adminProfile()} sheetRepository={repository} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Recycle Bin' }));
    expect(await screen.findByRole('heading', { name: 'Recycle bin' })).toBeInTheDocument();
    // The heading is shell chrome; the panel (and its row actions) arrive with
    // the lazily imported Recycle Bin chunk.
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    // SET-11: an in-app confirmation dialog (native window.confirm is gone).
    const restoreDialog = await screen.findByRole('dialog', { name: 'Restore this record?' });
    fireEvent.click(within(restoreDialog).getByRole('button', { name: 'Restore' }));
    await waitFor(async () => {
      expect((await repository.getRows()).find((candidate) => candidate.id === row.id)?.deleted).toBe(false);
    });

    await repository.softDeleteRow(row.id);
    fireEvent.click(screen.getByRole('button', { name: 'Recycle Bin' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const deleteDialog = await screen.findByRole('dialog', { name: 'Permanently delete this record?' });
    fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(async () => {
      expect((await repository.getRows()).find((candidate) => candidate.id === row.id)).toBeUndefined();
    });
    // Two lazy chunks load here (the shell's Recycle Bin view, then the panel
    // that renders the row actions). On a cold Windows runner that pair
    // occasionally exceeded 15 s and the failure said only "Test timed out";
    // the audit-log test below already uses 30 s for a single lazy view.
    // Nothing is skipped and no assertion changed.
  }, 30_000);

  it('lists repository audit history for administrators', async () => {
    const repository = await seededRepository();
    render(<AppShell profile={adminProfile()} sheetRepository={repository} />);

    fireEvent.click(screen.getByRole('button', { name: 'Audit Log' }));
    expect(await screen.findByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
    // S3: friendly action names (raw code "create" is no longer shown).
    expect(within(await screen.findByRole('table')).getByText('Created record')).toBeInTheDocument();
  }, 30_000);

describe('imported date columns (Blocker 2, integration)', () => {
  async function seededRepository() {
    const repository = createInMemorySheetRepository();
    await seedFixtureColumns(repository);
    await repository.createRow({
      name: 'Ada Lovelace',
      passport_no: 'A-1',
      visa_expiry: '2099-01-02',
    });
    return repository;
  }

  it('offers a Date type for imported date columns and creates date_expiry columns', async () => {
    const repository = await seededRepository();
    render(
      <AppShell activeView="sheet" profile={adminProfile()} sheetRepository={repository} />,
    );
    await screen.findByText('Ada Lovelace');

    const input = await screen.findByLabelText('Import CSV or Excel file');
    const file = new File(
      ['Name,Expiry Date\nGrace Hopper,10/01/2004\nMarianne,11/02/2005'],
      'people.csv',
      { type: 'text/csv' },
    );
    fireEvent.change(input, { target: { files: [file] } });

    const dialog = await screen.findByRole('dialog', { name: 'Import preview' });
    expect(dialog).toBeInTheDocument();
    // The unmapped date-like header is offered as a date column (default expiry).
    const typeSelect = screen.getByRole('combobox', { name: 'Type for Expiry Date' });
    expect(typeSelect).toHaveValue('date_expiry');
    expect(screen.getByText(/looks like dates/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Import mapped records' }));

    // Wait for BOTH the created date column and the persisted import — the
    // column is created before the rows are written inside confirmImport.
    await waitFor(async () => {
      const columns = await repository.getColumns();
      const expiry = columns.find((column) => column.name === 'Expiry Date');
      expect(expiry?.type).toBe('date_expiry');
      const rows = await repository.getRows();
      const grace = rows.find((row) => row.data.name === 'Grace Hopper');
      expect(grace?.data['expiry_date'] ?? grace?.data['Expiry Date']).toBe('2004-01-10');
    });
  }, 30_000);

  it('lets the admin convert a mapped text column holding dates', async () => {
    const repository = await seededRepository();
    // Seed an existing TEXT column that holds dates.
    await repository.addColumn({ id: 'start_date', name: 'Start date', type: 'text' });
    await repository.createRow({ name: 'Existing', start_date: '05/03/2020' });
    render(
      <AppShell activeView="sheet" profile={adminProfile()} sheetRepository={repository} />,
    );
    await screen.findByText('Ada Lovelace');

    const input = await screen.findByLabelText('Import CSV or Excel file');
    const file = new File(
      ['Name,Start date\nNew Person,10/01/2004'],
      'dates.csv',
      { type: 'text/csv' },
    );
    fireEvent.change(input, { target: { files: [file] } });

    const dialog = await screen.findByRole('dialog', { name: 'Import preview' });
    expect(dialog).toBeInTheDocument();
    // Warning that the mapped target is a text column with date-like values.
    expect(screen.getByText(/is mapped to the text column/)).toBeInTheDocument();
    const conversion = screen.getByRole('combobox', { name: 'Date handling for Start date' });
    expect(conversion).toHaveValue('keep');

    fireEvent.change(conversion, { target: { value: 'date_expiry' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import mapped records' }));

    // Wait for BOTH the converted column type and the persisted import — the
    // type flips at the start of confirmImport, rows are written later.
    await waitFor(async () => {
      const columns = await repository.getColumns();
      expect(columns.find((column) => column.id === 'start_date')?.type).toBe('date_expiry');
      const rows = await repository.getRows();
      // The pre-existing value was converted to ISO; the imported one too.
      const existing = rows.find((row) => row.data.name === 'Existing');
      const fresh = rows.find((row) => row.data.name === 'New Person');
      expect(existing?.data.start_date).toBe('2020-03-05');
      expect(fresh?.data.start_date).toBe('2004-01-10');
    });
    await waitFor(() => {
      expect(screen.getByText(/Converted 1 of 1 values in .Start date. to dates/)).toBeInTheDocument();
    });
  }, 30_000);
});

});
