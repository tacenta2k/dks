import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import {
  createCsvExport,
  createXlsxExport,
} from '../src/features/import-export/export-service';
import {
  importRows,
  previewImport,
} from '../src/features/import-export/import-service';
import type { ColumnDefinition } from '../src/lib/columns';
import type { SheetRow } from '../src/features/sheet/types';

const columns: ColumnDefinition[] = [
  { id: 'name', name: 'Name', type: 'text', position: 0 },
  { id: 'passport_no', name: 'Passport No', type: 'text', position: 1 },
  { id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', position: 2 },
];

const rows: SheetRow[] = [
  {
    id: 'row-1',
    data: { name: 'Ada, Lovelace', passport_no: 'A-1', visa_expiry: '2027-01-02' },
    deleted: false,
  },
];

describe('admin import and export workflows', () => {
  it('exports current rows as CSV using only the explicit column selection', () => {
    const result = createCsvExport({
      role: 'admin',
      rows,
      columns,
      selectedColumnIds: ['name', 'visa_expiry'],
      fileName: 'filtered.csv',
    });

    expect(result.fileName).toBe('filtered.csv');
    expect(result.mimeType).toContain('text/csv');
    expect(result.data).toBe('Name,Visa Expiry\r\n"Ada, Lovelace",2027-01-02\r\n');
  });

  it('exports an XLSX workbook that retains explicit headers and values', () => {
    const result = createXlsxExport({
      role: 'admin',
      rows,
      columns,
      selectedColumnIds: ['passport_no', 'name'],
      fileName: 'filtered.xlsx',
    });

    const workbook = XLSX.read(result.data, { type: 'array' });
    expect(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 })).toEqual([
      ['Passport No', 'Name'],
      ['A-1', 'Ada, Lovelace'],
    ]);
  });

  it('rejects office export and import attempts at the service boundary', async () => {
    expect(() => createCsvExport({ role: 'office', rows, columns })).toThrow(/administrator/i);
    await expect(previewImport('Name\nAda', {
      role: 'office',
      columns,
      fileName: 'rows.csv',
    })).rejects.toThrow(/administrator/i);
  });

  it('previews only the first 20 rows and maps existing columns while leaving unknown headers visible', async () => {
    const csv = [
      'Name,Passport No,Not Mapped',
      ...Array.from({ length: 21 }, (_, index) => `Person ${index + 1},P-${index + 1},ignored`),
    ].join('\n');

    const preview = await previewImport(csv, {
      role: 'admin',
      columns,
      fileName: 'rows.csv',
    });

    expect(preview.rows).toHaveLength(20);
    expect(preview.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ header: 'Name', columnId: 'name' }),
      expect.objectContaining({ header: 'Passport No', columnId: 'passport_no' }),
    ]));
    expect(preview.unmappedHeaders).toEqual(['Not Mapped']);
  });

  it('parses XLSX input through the same preview mapping path', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['Name', 'Visa Expiry'], ['Ada', '2027-01-02']]),
      'Rows',
    );
    const source = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });

    const preview = await previewImport(source, {
      role: 'admin',
      columns,
      fileName: 'rows.xlsx',
    });

    expect(preview.fileName).toBe('rows.xlsx');
    expect(preview.rows).toEqual([{ Name: 'Ada', 'Visa Expiry': '2027-01-02' }]);
    expect(preview.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ header: 'Visa Expiry', columnId: 'visa_expiry' }),
    ]));
  });

  it('creates mapped columns through the optional callback and emits import records and an audit payload', async () => {
    const created: string[] = [];
    const result = await importRows('Name,Department\nAda,Research', {
      role: 'admin',
      columns,
      actor: { id: 'user-1', name: 'Admin User' },
      fileName: 'rows.csv',
      createColumn: (header) => {
        created.push(header);
        return { id: 'department', name: header, type: 'text' };
      },
    });

    expect(created).toEqual(['Department']);
    expect(result.records).toEqual([
      expect.objectContaining({
        data: { name: 'Ada', department: 'Research' },
        sourceRowNumber: 2,
      }),
    ]);
    expect(result.auditPayload).toEqual(expect.objectContaining({
      action: 'import',
      actorId: 'user-1',
      details: expect.objectContaining({ importedRows: 1, fileName: 'rows.csv' }),
    }));
  });

  it('ignores unmapped fields by default when no create-column callback is supplied', async () => {
    const result = await importRows('Name,Unknown\nAda,ignored', {
      role: 'admin',
      columns,
      fileName: 'rows.csv',
    });

    expect(result.records[0]?.data).toEqual({ name: 'Ada' });
    expect(result.unmappedHeaders).toEqual(['Unknown']);
  });
});
