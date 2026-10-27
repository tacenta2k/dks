import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { jsPDF } from 'jspdf';

import {
  EXPIRY_REPORT_WINDOW_DAYS,
  EMPTY_VALUE,
  MAX_DETAIL_RECORDS,
  MAX_REPORT_RECORDS,
  UNNAMED_LABEL,
  buildDigestReportModel,
  computeSummary,
  formatReportValue,
  isWinAnsiEncodable,
  maskIdentifier,
  muscatCalendarParts,
  muscatTodayIso,
  normalizeReportColumns,
  pdfAttachmentFileName,
  renderDigestHtml,
  renderDigestText,
  rowLabel,
  sanitizePdfText,
  selectReportEntries,
  type ReportColumn,
  type ReportColumnType,
} from '../supabase/edge-functions/_shared/digest-report';
import { renderDigestPdf, type PdfDocument } from '../supabase/edge-functions/_shared/digest-pdf';
import { buildOutboxEmail, sanitizeDetail } from '../supabase/edge-functions/_shared/outbox-email';
import { dedupeKey } from '../supabase/edge-functions/_shared/email';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The PDF renderer is written against a tiny document interface so it can run
 * in Deno (npm:jspdf) and Node alike. These recording fakes let us assert on
 * layout order/content; real jsPDF is used separately to prove the bytes are a
 * valid PDF.
 */
class RecordingPdf implements PdfDocument {
  records: Array<Record<string, unknown>> = [];
  pages = 1;
  /** Set by `renderWithRecording` from the render result. */
  unsupportedText = false;
  font = 'helvetica';
  fontStyle = 'normal';
  fontSize = 12;
  color: [number, number, number] = [0, 0, 0];
  fillColor: [number, number, number] = [0, 0, 0];
  drawColor: [number, number, number] = [0, 0, 0];
  lineWidth = 1;

  setFont(font: string, style?: string): void {
    this.font = font;
    this.fontStyle = style ?? 'normal';
  }

  setFontSize(size: number): void {
    this.fontSize = size;
  }

  setTextColor(...color: [number, number, number]): void {
    this.color = color;
  }

  setFillColor(...color: [number, number, number]): void {
    this.fillColor = color;
  }

  setDrawColor(...color: [number, number, number]): void {
    this.drawColor = color;
  }

  setLineWidth(width: number): void {
    this.lineWidth = width;
  }

  getTextWidth(text: string): number {
    return text.length * this.fontSize * 0.5;
  }

  splitTextToSize(text: string, maxWidth: number): string[] {
    if (text === '') {
      return [];
    }
    const out: string[] = [];
    for (const rawLine of text.split('\n')) {
      if (this.getTextWidth(rawLine) <= maxWidth) {
        out.push(rawLine);
        continue;
      }
      let current = '';
      for (const word of rawLine.split(' ')) {
        const candidate = current ? `${current} ${word}` : word;
        if (!current || this.getTextWidth(candidate) <= maxWidth) {
          current = candidate;
        } else {
          out.push(current);
          current = word;
        }
      }
      if (current) {
        out.push(current);
      }
    }
    return out;
  }

  text(text: string, x: number, y: number, options?: { align?: 'left' | 'center' | 'right' }): void {
    this.records.push({ kind: 'text', text, x, y, align: options?.align, color: this.color });
  }

  line(x1: number, y1: number, _x2: number, _y2: number): void {
    this.records.push({ kind: 'line', x: x1, y: y1 });
  }

  rect(x: number, y: number, _w: number, _h: number): void {
    this.records.push({ kind: 'rect', x, y });
  }

  addPage(): void {
    this.pages += 1;
  }

  output(): ArrayBuffer {
    return new ArrayBuffer(0);
  }

  allText(): string {
    return this.records
      .filter((record) => record.kind === 'text')
      .map((record) => String(record.text ?? ''))
      .join('\n');
  }

  textsOfColor(color: [number, number, number]): string[] {
    return this.records
      .filter((record) => record.kind === 'text' && record.color === color)
      .map((record) => String(record.text ?? ''));
  }
}

type ValueColumn = Pick<ReportColumn, 'type'> & { sensitive?: boolean; id?: string; name?: string };

function col(partial: { id: string; name: string; type: ReportColumnType } & Partial<ReportColumn>): ReportColumn {
  return {
    id: partial.id,
    name: partial.name,
    type: partial.type,
    position: partial.position ?? 0,
    visible: partial.visible ?? true,
    isPrimaryExpiry: partial.isPrimaryExpiry ?? false,
    isPassport: partial.isPassport ?? false,
    sensitive: partial.sensitive ?? false,
  };
}

function makeColumns(): ReportColumn[] {
  return [
    col({ id: 'full_name', name: 'Full Name', type: 'text', position: 0 }),
    col({ id: 'passport_no', name: 'Passport No', type: 'text', position: 1, sensitive: true, isPassport: true }),
    col({ id: 'civil_id', name: 'Civil ID', type: 'civil_id', position: 2, sensitive: true }),
    col({ id: 'visa_expiry', name: 'Visa Expiry', type: 'date_expiry', position: 3 }),
    col({ id: 'fee', name: 'Fee', type: 'price', position: 4 }),
    col({ id: 'active', name: 'Active', type: 'checkbox', position: 5 }),
    col({ id: 'notes', name: 'Notes', type: 'notes', position: 6 }),
  ];
}

function renderWithRecording(model: ReturnType<typeof buildDigestReportModel>): RecordingPdf {
  // Mirror the production two-pass: page count first, then the final pass with
  // the total so the footer can print "Page X of Y".
  const probe = new RecordingPdf();
  const first = renderDigestPdf(probe, model, { totalPages: 0 });
  const doc = new RecordingPdf();
  const result = renderDigestPdf(doc, model, { totalPages: first.pages });
  doc.unsupportedText = result.unsupportedText;
  return doc;
}

function renderToBytes(model: ReturnType<typeof buildDigestReportModel>): {
  bytes: Uint8Array;
  pages: number;
  unsupportedText: boolean;
} {
  const doc = new jsPDF();
  const result = renderDigestPdf(doc, model, { totalPages: 0 });
  const arrayBuffer = doc.output('arraybuffer') as ArrayBuffer;
  return { bytes: new Uint8Array(arrayBuffer), pages: result.pages, unsupportedText: result.unsupportedText };
}

function model(overrides: Partial<Parameters<typeof buildDigestReportModel>[0]> = {}) {
  return buildDigestReportModel({
    reportDateIso: '2026-10-26',
    columns: makeColumns(),
    currency: 'ر.ع.',
    includeFullIds: false,
    entries: [],
    ...overrides,
  });
}

describe('Muscat business date', () => {
  it('rolls the report date at Muscat midnight, not UTC midnight', () => {
    expect(muscatTodayIso('2026-10-26T19:59:00Z')).toBe('2026-10-26');
    expect(muscatTodayIso('2026-10-26T20:00:00Z')).toBe('2026-10-27');
    expect(muscatTodayIso('2026-10-26T23:59:00Z')).toBe('2026-10-27');
  });

  it('falls back to the UTC date when no instant is supplied', () => {
    expect(muscatTodayIso('2026-10-26')).toBe('2026-10-26');
  });

  it('resolves calendar parts in Muscat local time, not UTC', () => {
    expect(muscatCalendarParts(new Date('2026-10-26T19:59:00Z'))).toEqual({ year: 2026, month: 10, day: 26 });
    expect(muscatCalendarParts(new Date('2026-10-26T20:00:00Z'))).toEqual({ year: 2026, month: 10, day: 27 });
  });

  it('defaults to the current moment so a scheduled run never gets an empty date', () => {
    expect(muscatCalendarParts()).not.toBeNull();
    expect(muscatTodayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('30-day rolling window and ordering', () => {
  const today = '2026-10-26';
  const entries = [
    { id: 'a', expiry: '2026-10-25', data: { full_name: 'A' } },
    { id: 'b', expiry: '2026-10-20', data: { full_name: 'B' } },
    { id: 'c', expiry: '2026-10-26', data: { full_name: 'C' } },
    { id: 'd', expiry: '2026-11-02', data: { full_name: 'D' } },
    { id: 'e', expiry: '2026-11-25', data: { full_name: 'E' } },
    { id: 'f', expiry: '2026-11-26', data: { full_name: 'F' } },
    { id: 'g', expiry: '', data: { full_name: 'G' } },
    { id: 'h', expiry: 'not-a-date', data: { full_name: 'H' } },
    { id: 'i', expiry: '2026-02-31', data: { full_name: 'I' } },
    { id: 'j', expiry: '2026-11-10', data: { full_name: 'J' }, deleted: true },
  ];

  it('keeps expired → today → 1..30 and drops anything outside the window', () => {
    const selected = selectReportEntries(entries, makeColumns(), today);
    expect(selected.map((entry) => entry.id)).toEqual(['b', 'a', 'c', 'd', 'e']);
    // j was soft-deleted: excluded even though it is inside the window.
    expect(selected.map((entry) => entry.id)).not.toContain('j');
    expect(selected.map((entry) => entry.daysLeft)).toEqual([-6, -1, 0, 7, 30]);
  });

  it('reports the correct status text for each band', () => {
    const selected = selectReportEntries(entries, makeColumns(), today);
    const byId = new Map(selected.map((entry) => [entry.id, entry.status]));
    expect(byId.get('b')).toBe('Expired');
    expect(byId.get('a')).toBe('Expired');
    expect(byId.get('c')).toBe('Expires today');
    expect(byId.get('d')).toBe('Expires in 7 days');
    expect(byId.get('e')).toBe('Expires in 30 days');
  });

  it('excludes missing, malformed and impossible dates', () => {
    const selected = selectReportEntries(entries, makeColumns(), today);
    const ids = selected.map((entry) => entry.id);
    expect(ids).not.toContain('g');
    expect(ids).not.toContain('h');
    expect(ids).not.toContain('i');
    expect(ids).not.toContain('f');
  });

  it('never uses the label for ordering — expiry is the only sort key', () => {
    // 'Zeta' expires soonest but sorts first because of expiry, not the name.
    const mixed = [
      { id: '1', expiry: '2026-11-20', data: { full_name: 'Zeta' } },
      { id: '2', expiry: '2026-10-27', data: { full_name: 'Alpha' } },
    ];
    const selected = selectReportEntries(mixed, makeColumns(), today);
    expect(selected.map((entry) => entry.id)).toEqual(['2', '1']);
  });

  it('is stable when two records share an expiry', () => {
    const tied = [
      { id: 'first', expiry: '2026-10-27', data: { full_name: 'Alpha' } },
      { id: 'second', expiry: '2026-10-27', data: { full_name: 'Alpha' } },
    ];
    const first = selectReportEntries(tied, makeColumns(), today).map((entry) => entry.id);
    expect(first).toEqual(['first', 'second']);
  });
});

describe('renewal and the next Muscat calendar day', () => {
  const columns = makeColumns();

  it('leaves the report when the renewal is outside the window', () => {
    const expiry = '2026-12-06'; // 41 days from the report date
    expect(selectReportEntries([{ id: 'r', expiry, data: { full_name: 'R' } }], columns, '2026-10-26')).toHaveLength(0);
  });

  it('stays on screen when the renewal is still inside the window', () => {
    const selected = selectReportEntries([{ id: 'r', expiry: '2026-10-28', data: { full_name: 'R' } }], columns, '2026-10-26');
    expect(selected[0].daysLeft).toBe(2);
    expect(selected[0].status).toBe('Expires in 2 days');
  });

  it('recomputes from the new expiry after the Muscat midnight rollover', () => {
    const selected = selectReportEntries([{ id: 'r', expiry: '2026-10-27', data: { full_name: 'R' } }], columns, '2026-10-27');
    expect(selected[0].daysLeft).toBe(0);
    expect(selected[0].status).toBe('Expires today');
  });

  it('keeps a renewed record in the report once the old expiry is gone', () => {
    // Renewed to 25 days out; the stale value must not survive anywhere.
    const selected = selectReportEntries([{ id: 'r', expiry: '2026-11-20', data: { full_name: 'R' } }], columns, '2026-10-26');
    expect(selected[0].daysLeft).toBe(25);
  });
});

describe('report window and limits', () => {
  it('exports a 30-day window, a 200-row summary cap and a 100-block detail cap', () => {
    expect(EXPIRY_REPORT_WINDOW_DAYS).toBe(30);
    expect(MAX_REPORT_RECORDS).toBe(200);
    expect(MAX_DETAIL_RECORDS).toBe(100);
  });

  it('marks truncation and reports the full qualifying count', () => {
    const many = Array.from({ length: MAX_REPORT_RECORDS + 15 }, (_, index) => ({
      id: `row-${index}`,
      expiry: `2026-11-${String((index % 20) + 1).padStart(2, '0')}`,
      data: { full_name: `Row ${index}` },
    }));
    const report = model({ entries: many, totalQualifying: MAX_REPORT_RECORDS + 15 });
    expect(report.summary.total).toBe(MAX_REPORT_RECORDS);
    expect(report.truncated).toBe(true);
    expect(report.totalQualifying).toBe(MAX_REPORT_RECORDS + 15);
    expect(report.entries.length).toBe(MAX_REPORT_RECORDS);
  });

  it('uses the explicit totalQualifying when it is smaller than the entry count', () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      id: `row-${index}`,
      expiry: '2026-11-05',
      data: { full_name: `Row ${index}` },
    }));
    const report = model({ entries, totalQualifying: 2 });
    expect(report.totalQualifying).toBe(2);
    expect(report.truncated).toBe(false);
  });
});

describe('dynamic columns', () => {
  it('drops system columns and renders active user columns in workspace order', () => {
    const raw = [
      { id: '__rowNumber', name: '__rowNumber', type: 'number', position: 0, visible: true },
      { id: 'daysLeft', name: 'Days Left', type: 'number', position: 1, visible: true },
      { id: '__actions', name: '__actions', type: 'text', position: 2, visible: true },
      { id: 'full_name', name: 'Full Name', type: 'text', position: 3, visible: true },
      { id: 'notes', name: 'Notes', type: 'notes', position: 4, visible: true },
    ];
    const columns = normalizeReportColumns(raw);
    expect(columns.map((column) => column.id)).toEqual(['full_name', 'notes']);
  });

  it('reflects an added column, a renamed column and a reorder in the PDF', () => {
    const entries = [{ id: 'r', expiry: '2026-11-01', data: { full_name: 'Ali', sponsorship: 'ABC' } }];

    const base = model({ columns: makeColumns(), entries });
    const baseText = renderWithRecording(base).allText();
    expect(baseText).toContain('Full Name');
    expect(baseText).not.toContain('Sponsorship');

    // Add + rename + reorder in one change; the report must follow.
    const changed = model({
      columns: [
        { id: 'sponsorship', name: 'Sponsorship', type: 'text', position: 0, visible: true, sensitive: false },
        { id: 'full_name', name: 'Given Name', type: 'text', position: 1, visible: true, sensitive: false },
      ],
      entries,
    });
    const changedText = renderWithRecording(changed).allText();
    expect(changedText).toContain('Sponsorship');
    expect(changedText).toContain('Given Name');
    expect(changedText).not.toContain('Full Name');

    // Field labels are drawn in workspace order.
    const order = renderWithRecording(changed)
      .records
      .filter((record) => record.kind === 'text')
      .map((record) => String(record.text ?? ''))
      .indexOf('Sponsorship');
    const given = renderWithRecording(changed)
      .records
      .filter((record) => record.kind === 'text')
      .map((record) => String(record.text ?? ''))
      .indexOf('Given Name');
    expect(order).toBeGreaterThan(-1);
    expect(given).toBeGreaterThan(order);
  });

  it('hides a column marked invisible and keeps visible ones', () => {
    const columns = normalizeReportColumns([
      { id: 'full_name', name: 'Full Name', type: 'text', position: 0, visible: true },
      { id: 'notes', name: 'Notes', type: 'notes', position: 1, visible: false },
    ]);
    expect(columns.map((column) => column.id)).toEqual(['full_name']);
  });

  it('does not print Days Left as a user column — the report manages it', () => {
    const columns = [
      { id: 'daysLeft', name: 'Days Left', type: 'number', position: 0, visible: true },
      { id: 'full_name', name: 'Full Name', type: 'text', position: 1, visible: true },
    ];
    const report = model({ columns, entries: [{ id: 'r', expiry: '2026-11-02', data: { full_name: 'Ali', daysLeft: 999 } }] });
    const text = renderWithRecording(report).allText();
    expect(text).toContain('Expires in 7 days');
    expect(text).not.toContain('999');
    expect(text).not.toMatch(/\bDays Left\b\s*7\b/);
  });
});

describe('value formatting', () => {
  const textColumn = col({ id: 'x', name: 'X', type: 'text' });
  const currency = { code: 'OMR', symbol: 'ر.ع.', decimals: 3 };
  const fmt = (
    value: unknown,
    column: ValueColumn = textColumn,
    includeFullIds = false,
    asciiSafe = false,
  ) => formatReportValue(
    value,
    { type: column.type, sensitive: column.sensitive === true },
    { includeFullIds, currency, asciiSafe },
  );

  it('formats dates as DD/MM/YYYY and keeps impossible dates as text', () => {
    expect(fmt('2026-11-01', { ...textColumn, type: 'date_start' })).toBe('01/11/2026');
    // 31 February does not exist: keep the stored text rather than blanking it.
    expect(fmt('2026-02-31', { ...textColumn, type: 'date_expiry' })).toBe('2026-02-31');
  });

  it('keeps numeric leading zeroes for identifiers', () => {
    expect(fmt('007')).toBe('007');
    expect(fmt(12, { ...textColumn, type: 'number' })).toBe('12');
  });

  it('renders checkboxes as Yes/No and blanks as an empty placeholder', () => {
    expect(fmt(true, { ...textColumn, type: 'checkbox' })).toBe('Yes');
    expect(fmt(1, { ...textColumn, type: 'checkbox' })).toBe('Yes');
    expect(fmt('false', { ...textColumn, type: 'checkbox' })).toBe('No');
    expect(fmt(false, { ...textColumn, type: 'checkbox' })).toBe('No');
    expect(fmt(null, { ...textColumn, type: 'checkbox' })).toBe(EMPTY_VALUE);
  });

  it('formats currency with three decimals and a fallback symbol', () => {
    expect(fmt(1234.5, { ...textColumn, type: 'price' })).toBe('ر.ع. 1,234.500');
    // A non-WinAnsi symbol would render as ??? in the PDF, so the ISO code is used.
    expect(fmt(1234.5, { ...textColumn, type: 'price' }, false, true)).toBe('OMR 1,234.500');
  });

  it('keeps the mask prefix encodable by the PDF font', () => {
    // Regression: U+2022 is WinAnsi (cp1252 byte 0x95) but is not a contiguous
    // code point, so a naive range check turned "•••• 3456" into "???? 3456".
    expect(sanitizePdfText(maskIdentifier('P1234567')).text).toBe('•••• 4567');
    expect(sanitizePdfText(maskIdentifier('P1234567')).unsupported).toBe(false);
    expect(isWinAnsiEncodable('•••• 4567')).toBe(true);
    expect(isWinAnsiEncodable('عمر')).toBe(false);
  });

  it('renders long values as text rather than dropping them', () => {
    const long = 'x'.repeat(400);
    const out = fmt(long);
    expect(out).toContain(long.slice(0, 50));
    expect(out).toHaveLength(long.length);
  });

  it('falls back to a value keyed by name when the column id is absent', () => {
    expect(fmt('Ali', { id: 'missing', name: 'Full Name', type: 'text' })).toBe('Ali');
  });
});

describe('sensitive identifier masking', () => {
  const passport = col({ id: 'passport_no', name: 'Passport No', type: 'text', sensitive: true, isPassport: true });
  const civil = col({ id: 'civil_id', name: 'Civil ID', type: 'civil_id', sensitive: true });
  const currency = { code: 'OMR', symbol: 'ر.ع.', decimals: 3 };
  const fmt = (
    value: unknown,
    column: ValueColumn = passport,
    includeFullIds = false,
  ) => formatReportValue(
    value,
    { type: column.type, sensitive: column.sensitive === true },
    { includeFullIds, currency },
  );

  it('masks by default and keeps the value only when explicitly opted in', () => {
    expect(fmt('P1234567')).toBe(maskIdentifier('P1234567'));
    expect(fmt('P1234567')).not.toContain('P1234567');
    expect(fmt('P1234567', passport, true)).toBe('P1234567');

    expect(fmt('009988776655', civil)).toContain('••••');
    expect(fmt('009988776655', civil, true)).toBe('009988776655');
  });

  it('masks short identifiers completely', () => {
    expect(maskIdentifier('AB12')).toBe('••••••');
    expect(maskIdentifier('12')).toBe('••••••');
  });

  it('keeps the HTML summary free of identifiers even when the opt-in is on', () => {
    const entries = [{ id: 'r', expiry: '2026-11-01', data: { full_name: 'Ali', passport_no: 'P1234567', civil_id: '009988776655' } }];
    // The HTML summary only lists record/expiry/status, so it never carries a
    // sensitive value regardless of the opt-in.
    for (const includeFullIds of [false, true]) {
      const html = renderDigestHtml(model({ entries, includeFullIds }));
      const text = renderDigestText(model({ entries, includeFullIds }));
      expect(html).not.toContain('P1234567');
      expect(html).not.toContain('009988776655');
      expect(text).not.toContain('P1234567');
      expect(text).not.toContain('009988776655');
    }
  });

  it('masks identifiers in the PDF unless the administrator opted in', () => {
    const entries = [{ id: 'r', expiry: '2026-11-01', data: { full_name: 'Ali', passport_no: 'P1234567' } }];
    const masked = renderWithRecording(model({ entries })).allText();
    expect(masked).not.toContain('P1234567');
    expect(masked).toContain('••••');

    const full = renderWithRecording(model({ entries, includeFullIds: true })).allText();
    expect(full).toContain('P1234567');
  });

  it('says when identifiers are masked and when they are shown', () => {
    const entries = [{ id: 'r', expiry: '2026-11-01', data: { full_name: 'Ali', passport_no: 'P1234567' } }];
    expect(renderDigestHtml(model({ entries }))).toMatch(/Passport and Civil ID values are masked/);
    expect(renderDigestHtml(model({ entries, includeFullIds: true }))).not.toMatch(/are masked/);
  });

  it('never shows a label derived from a sensitive identifier', () => {
    const columns = [passport, civil];
    expect(rowLabel({ passport_no: 'P1234567' }, columns)).toBe(UNNAMED_LABEL);
    expect(rowLabel({ civil_id: '009988776655', passport_no: 'P1234567' }, columns)).toBe(UNNAMED_LABEL);
  });

  it('never falls back to a raw UUID as the row label', () => {
    const id = '3f6b1c2e-9d4a-4f1e-8c3b-2a5d7e9f0b1c';
    expect(rowLabel({ id }, [])).toBe(UNNAMED_LABEL);
    expect(rowLabel({ notes: 'Real note' }, [])).toBe('Real note');
  });

  it('keeps the first non-sensitive name-like value as the label', () => {
    expect(rowLabel({ full_name: 'Ali', passport_no: 'P1234567' }, makeColumns())).toBe('Ali');
  });
});

describe('summary math', () => {
  it('counts expired, due today and the upcoming bands', () => {
    const entries = selectReportEntries([
      { id: 'a', expiry: '2026-10-25', data: {} },
      { id: 'b', expiry: '2026-10-24', data: {} },
      { id: 'c', expiry: '2026-10-26', data: {} },
      { id: 'd', expiry: '2026-10-31', data: {} },
      { id: 'e', expiry: '2026-11-05', data: {} },
    ], makeColumns(), '2026-10-26');
    expect(computeSummary(entries)).toEqual({
      total: 5,
      expired: 2,
      today: 1,
      within7: 1,
      within30: 2,
    });
  });

  it('is empty and calm when nothing qualifies', () => {
    expect(computeSummary([])).toEqual({ total: 0, expired: 0, today: 0, within7: 0, within30: 0 });
  });
});

describe('report media', () => {
  it('renders an HTML summary with inline styles and text statuses', () => {
    const entries = [
      { id: 'a', expiry: '2026-10-25', data: { full_name: 'Ali' } },
      { id: 'b', expiry: '2026-10-26', data: { full_name: 'Sara' } },
      { id: 'c', expiry: '2026-11-02', data: { full_name: 'Omar' } },
    ];
    const html = renderDigestHtml(model({ entries }));
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('style="');
    expect(html).toContain('<table');
    expect(html).toContain('Expired');
    expect(html).toContain('Expires today');
    expect(html).toContain('Expires in 7 days');
    expect(html).toContain('Ali');
    expect(html).toContain('Report date: 26/10/2026');
    expect(html).toContain('A PDF with the full Visa Sheet columns is attached');
    expect(html).toContain('DKS-expiry-report-2026-10-26.pdf');
  });

  it('renders a plain-text fallback', () => {
    const entries = [{ id: 'a', expiry: '2026-10-25', data: { full_name: 'Ali' } }];
    const text = renderDigestText(model({ entries }));
    expect(text).toContain('DKS Daily Expiry Report');
    expect(text).toContain('Report date: 26/10/2026');
    expect(text).toContain('Ali');
    expect(text).toContain('Expired');
    expect(text).toContain('Passport and Civil ID values are masked');
    expect(text).toContain('A PDF with the full Visa Sheet columns is attached: DKS-expiry-report-2026-10-26.pdf');
  });

  it('explains the empty day without inventing rows', () => {
    const report = model({ entries: [] });
    const text = renderDigestText(report);
    expect(text).toContain('All clear');
    expect(text).toContain('nothing expiring within the next 30 days');
    expect(renderDigestHtml(report)).toContain('All clear');
    expect(report.summary.total).toBe(0);
  });

  it('builds the attachment filename from the Muscat report date', () => {
    expect(pdfAttachmentFileName('2026-10-26')).toBe('DKS-expiry-report-2026-10-26.pdf');
  });
});

describe('PDF rendering', () => {
  it('emits a valid PDF and reports every page', () => {
    const entries = Array.from({ length: MAX_DETAIL_RECORDS }, (_, index) => ({
      id: `r${index}`,
      expiry: '2026-11-01',
      data: { full_name: `Row ${index}` },
    }));
    const { bytes, pages } = renderToBytes(model({ entries }));
    expect(pages).toBeGreaterThan(1);
    const header = new TextDecoder('latin1').decode(bytes.slice(0, 4));
    expect(header).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('is a single page with the calm message when nothing qualifies', () => {
    const { bytes, pages } = renderToBytes(model({ entries: [] }));
    expect(pages).toBe(1);
    const text = renderWithRecording(model({ entries: [] })).allText();
    expect(text).toContain('All clear');
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 4))).toBe('%PDF');
  });

  it('paginates and prints Page X of Y footers', () => {
    const entries = Array.from({ length: MAX_DETAIL_RECORDS }, (_, index) => ({
      id: `r${index}`,
      expiry: '2026-11-01',
      data: { full_name: `Row ${index}` },
    }));
    const doc = renderWithRecording(model({ entries }));
    expect(doc.pages).toBeGreaterThan(1);
    const footers = doc.allText().split('\n').filter((line) => line.startsWith('Page '));
    expect(footers.length).toBeGreaterThan(1);
    expect(footers[0]).toMatch(/^Page 1 of \d+$/);
    expect(new Set(footers.map((line) => line.split(' of ')[1])).size).toBe(1);
  });

  it('never splits a detail block across a page boundary', () => {
    const entries = Array.from({ length: MAX_DETAIL_RECORDS }, (_, index) => ({
      id: `r${index}`,
      expiry: '2026-11-01',
      data: { full_name: `Row ${index}`, notes: 'a reasonably long note that should wrap onto several lines' },
    }));
    const doc = renderWithRecording(model({ entries }));
    const lastIndex = doc.records.filter((record) => record.kind === 'text').length;
    expect(lastIndex).toBeGreaterThan(0);
    // The footer is drawn on the page it belongs to, and a new page was opened.
    expect(doc.pages).toBeGreaterThan(1);
    expect(doc.allText()).toContain('Generated by DKS');
  });

  it('draws the status text next to the record label', () => {
    const entries = [
      { id: 'a', expiry: '2026-10-25', data: { full_name: 'Ali' } },
      { id: 'b', expiry: '2026-11-01', data: { full_name: 'Sara' } },
    ];
    const doc = renderWithRecording(model({ entries }));
    expect(doc.allText()).toContain('Ali');
    expect(doc.allText()).toContain('Sara');
    expect(doc.allText()).toContain('Expired');
    expect(doc.allText()).toContain('Expires in 6 days');
  });

  it('wraps long values instead of truncating them', () => {
    const long = 'n'.repeat(300);
    const entries = [{ id: 'a', expiry: '2026-11-01', data: { full_name: long } }];
    const doc = renderWithRecording(model({ entries }));
    const joined = doc.records
      .filter((record) => record.kind === 'text')
      .map((record) => String(record.text ?? ''))
      .join(' ');
    expect(joined).toContain('n'.repeat(200));
  });

  it('reports characters the WinAnsi font cannot encode instead of garbling them', () => {
    const entries = [{ id: 'a', expiry: '2026-11-01', data: { full_name: 'عمر' } }];
    const doc = renderWithRecording(model({ entries }));
    expect(doc.unsupportedText).toBe(true);
    expect(doc.allText()).toContain('?');
  });

  it('sanitizes unsupported characters explicitly', () => {
    expect(sanitizePdfText('عمر').unsupported).toBe(true);
    expect(sanitizePdfText('عمر').text).toBe('???');
    expect(sanitizePdfText('Ali').unsupported).toBe(false);
    expect(sanitizePdfText('Ali').text).toBe('Ali');
  });

  it('says identifiers are masked and lists every active column in the detail blocks', () => {
    const entries = [{ id: 'a', expiry: '2026-11-01', data: { full_name: 'Ali', passport_no: 'P1234567' } }];
    const doc = renderWithRecording(model({ entries }));
    const text = doc.allText();
    expect(text).toContain('Passport and Civil ID values are masked');
    // Detail block: label, then each active column in workspace order.
    expect(text).toContain('Full Name');
    expect(text).toContain('Passport No');
    expect(text).toContain('Visa Expiry');
    expect(text).toContain('Notes');
  });

  it('truncates the detail blocks beyond the cap and says so', () => {
    const entries = Array.from({ length: MAX_DETAIL_RECORDS + 5 }, (_, index) => ({
      id: `r${index}`,
      expiry: '2026-11-01',
      data: { full_name: `Row ${index}` },
    }));
    const doc = renderWithRecording(model({ entries }));
    expect(doc.allText()).toContain('Detail blocks are truncated to the first 100 records');
  });
});

describe('outbox email assembly', () => {
  it('sends the Office sign-in notification with no attachment and no session link', () => {
    const built = buildOutboxEmail({
      kind: 'office_signin_request',
      payload: { requestedAt: '2026-10-26T10:00:00Z', email: 'office@example.com' },
    })!;
    expect(built.hasAttachment).toBe(false);
    expect(built.pdfFileName).toBeNull();
    expect(built.model).toBeNull();
    expect(built.html).not.toMatch(/api\.supabasecompat|token|session_id/i);
    expect(built.html).toContain('Open DKS to review');
    expect(built.text).toContain('Open DKS to review');
    expect(built.text).not.toMatch(/\/app|token=|session_id/i);
  });

  it('sends the digest with a PDF attachment decision', () => {
    const built = buildOutboxEmail({
      kind: 'expiry_digest',
      payload: {
        reportDate: '2026-10-26',
        currency: 'ر.ع.',
        columns: makeColumns(),
        includeFullIds: false,
        entries: [{ id: 'a', expiry: '2026-11-01', data: { full_name: 'Ali' } }],
      },
    })!;
    expect(built.hasAttachment).toBe(true);
    expect(built.pdfFileName).toBe('DKS-expiry-report-2026-10-26.pdf');
    expect(built.subject).toBe('DKS Daily Expiry Report — 26/10/2026');
    expect(built.html).toContain('Ali');
  });

  it('refuses an unknown row kind', () => {
    expect(buildOutboxEmail({ kind: 'unknown' as never, payload: {} })).toBeNull();
  });

  it('produces a digest dedupe key scoped to recipient and Muscat date', () => {
    expect(dedupeKey('expiry_digest', ['a@example.com', '2026-10-26'])).toBe(
      'expiry_digest:a@example.com:2026-10-26',
    );
  });

  it('sanitizes delivery details without leaking payloads', () => {
    expect(sanitizeDetail('boom')).toBe('boom');
    expect(sanitizeDetail('line\nbreak\ttab')).toBe('line break tab');
    expect(sanitizeDetail('x'.repeat(500))).toHaveLength(160);
    expect(sanitizeDetail('resend-http-429')).toBe('resend-http-429');
    expect(sanitizeDetail('a'.repeat(400) + 'b')).toHaveLength(160);
  });
});

describe('privacy and persistence guardrails', () => {
  function walk(dir: string): string[] {
    if (!existsSync(dir)) {
      return [];
    }
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...walk(full));
      } else if (full.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  const edgeFunctionsDir = resolve(__dirname, '../supabase/edge-functions');

  it('never writes to disk, Storage or the database from the edge functions', () => {
    const files = walk(edgeFunctionsDir);
    expect(files.length).toBeGreaterThan(0);
    const forbidden = [
      'Deno.writeTextFile',
      'Deno.write',
      'node:fs',
      'writeFileSync',
      '.storage.',
      'download',
      'createSignedUploadUrl',
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${file} should not use ${pattern}`).not.toContain(pattern);
      }
    }
  });

  it('keeps the digest PDF in memory only — no storage or file APIs', () => {
    const sendEmail = readFileSync(join(edgeFunctionsDir, 'send-email/index.ts'), 'utf8');
    expect(sendEmail).not.toMatch(/storage|upload|writeFile|Deno\.write/);
    expect(sendEmail).toContain("output('arraybuffer')");
  });

  it('lets only administrators write settings, so Office can never opt into full identifiers', () => {
    const schema = readFileSync(resolve(__dirname, '../supabase/schema.sql'), 'utf8');
    // The include_full_ids pref lives in the settings row; the RLS policies for
    // settings must be admin-only for insert/update/delete.
    for (const command of ['insert', 'update', 'delete']) {
      const policies = schema.match(
        new RegExp(
          `create policy\\s+\\w+\\s+on\\s+public\\.settings\\s+for\\s+${command}\\s+to\\s+\\w+[\\s\\S]*?;`,
          'gi',
        ),
      ) ?? [];
      expect(policies).toHaveLength(1);
      expect(policies[0]).toMatch(/public\.is_admin\(\)/);
    }
    expect(schema).toMatch(/include_full_ids/);
  });
});
