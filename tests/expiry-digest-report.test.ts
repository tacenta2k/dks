import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { jsPDF } from 'jspdf';

import {
  DIGEST_ATTACHMENT_SENTENCE,
  DIGEST_EMPTY_HEADLINE,
  EMPTY_DAY_NOTE,
  EMPTY_VALUE,
  EXPIRY_REPORT_WINDOW_DAYS,
  MAX_INLINE_LIST_ITEMS,
  MAX_REPORT_RECORDS,
  UNNAMED_LABEL,
  buildDigestReportModel,
  computeSummary,
  currencyFallbackNote,
  formatDaysLeft,
  formatReportValue,
  isWinAnsiEncodable,
  maskIdentifier,
  muscatCalendarParts,
  muscatDateTimeDisplay,
  muscatTodayIso,
  normalizeReportColumns,
  pdfAttachmentFileName,
  renderDigestHtml,
  renderDigestText,
  reportDateTimeLabel,
  rowLabel,
  sanitizePdfText,
  selectReportEntries,
  summaryCountItems,
  summaryLine,
  truncationNote,
  type ReportColumn,
  type ReportColumnType,
} from '../supabase/edge-functions/_shared/digest-report';
import {
  PDF_DOCUMENT_OPTIONS,
  buildGridColumns,
  buildGridTable,
  planGridGroups,
  renderDigestPdf,
  type PdfDocument,
} from '../supabase/edge-functions/_shared/digest-pdf';
import { bytesToBase64 } from '../supabase/edge-functions/_shared/base64';
import { buildOutboxEmail, sanitizeDetail } from '../supabase/edge-functions/_shared/outbox-email';
import { dedupeKey } from '../supabase/edge-functions/_shared/email';

const __dirname = dirname(fileURLToPath(import.meta.url));
const edgeFunctionsDir = resolve(__dirname, '../supabase/edge-functions');
const sendEmailSource = readFileSync(resolve(edgeFunctionsDir, 'send-email/index.ts'), 'utf8');

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

  rect(x: number, y: number, w: number, h: number, style?: 'S' | 'F' | 'FD' | 'FS'): void {
    this.records.push({ kind: 'rect', x, y, w, h, style: style ?? 'S', fill: this.fillColor });
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
    // Colours are compared by VALUE: each setTextColor call stores a fresh RGB
    // triple, so reference equality would never match.
    const expected = color.join(',');
    return this.records
      .filter((record) => record.kind === 'text'
        && Array.isArray(record.color)
        && (record.color as number[]).join(',') === expected)
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
  const doc = new jsPDF(PDF_DOCUMENT_OPTIONS);
  const result = renderDigestPdf(doc as never, model, { totalPages: 0 });
  const arrayBuffer = doc.output('arraybuffer') as ArrayBuffer;
  return { bytes: new Uint8Array(arrayBuffer), pages: result.pages, unsupportedText: result.unsupportedText };
}

/**
 * Product default: FULL identifiers (the PDF goes only to the Admin mailbox).
 * `generatedAt` is fixed so the printed Asia/Muscat date/time is deterministic.
 */
function model(overrides: Partial<Parameters<typeof buildDigestReportModel>[0]> = {}) {
  return buildDigestReportModel({
    reportDateIso: '2026-10-26',
    generatedAt: '2026-10-26T10:05:00Z',
    columns: makeColumns(),
    currency: 'ر.ع.',
    includeFullIds: true,
    entries: [],
    ...overrides,
  });
}

/** A spread of urgency bands for the layout tests (−3, 0, 5, 12 days). */
function bandEntries() {
  return [
    { id: 'expired', expiry: '2026-10-23', data: { full_name: 'Ali Hassan', passport_no: 'P1234567', civil_id: '009988776655', fee: 12.5 } },
    { id: 'today', expiry: '2026-10-26', data: { full_name: 'Sara', passport_no: 'P7654321', fee: 3 } },
    { id: 'soon', expiry: '2026-10-31', data: { full_name: 'Omar', passport_no: 'P2222222' } },
    { id: 'later', expiry: '2026-11-07', data: { full_name: 'Noor', passport_no: 'P3333333' } },
  ];
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
  it('exports a 30-day window and a single 200-row grid cap', () => {
    expect(EXPIRY_REPORT_WINDOW_DAYS).toBe(30);
    expect(MAX_REPORT_RECORDS).toBe(200);
    // The old 100-record detail-block cap is gone: every row is a grid row.
    expect(MAX_INLINE_LIST_ITEMS).toBeLessThan(MAX_REPORT_RECORDS);
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
    const headers = buildGridColumns(report).map((column) => column.header);
    expect(headers).toEqual(['Record', 'Full Name', 'Expiry', 'Days left', 'Status']);
    const text = renderWithRecording(report).allText();
    expect(text).toContain('Expires in 7 days');
    expect(text).not.toContain('999');
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

  it('returns full values when the flag is on and masks only on an explicit opt-out', () => {
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

  it('puts FULL identifiers in the PDF by default and masks them only when opted out', () => {
    const entries = [{ id: 'r', expiry: '2026-11-01', data: { full_name: 'Ali', passport_no: 'P1234567', civil_id: '009988776655' } }];

    // Default (flag omitted) → the Admin can read the numbers and call.
    const full = renderWithRecording(model({ entries })).allText();
    expect(full).toContain('P1234567');
    expect(full).toContain('009988776655');

    // Explicit opt-out → masked, and the report says so.
    const masked = renderWithRecording(model({ entries, includeFullIds: false })).allText();
    expect(masked).not.toContain('P1234567');
    expect(masked).not.toContain('009988776655');
    expect(masked).toContain('••••');
    expect(masked).toContain('Passport and Civil ID values are masked');
  });

  it('says when identifiers are masked and when they are shown in full', () => {
    const entries = [{ id: 'r', expiry: '2026-11-01', data: { full_name: 'Ali', passport_no: 'P1234567' } }];
    expect(renderDigestHtml(model({ entries, includeFullIds: false })))
      .toMatch(/Passport and Civil ID values are masked/);
    const full = renderDigestHtml(model({ entries }));
    expect(full).not.toMatch(/are masked/);
    expect(full).toMatch(/Full Passport and Civil ID values are included/);
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
  it('keeps the HTML body short, styled inline and free of the grid', () => {
    const entries = [
      { id: 'a', expiry: '2026-10-23', data: { full_name: 'Ali' } },
      { id: 'b', expiry: '2026-10-26', data: { full_name: 'Sara' } },
      { id: 'c', expiry: '2026-10-31', data: { full_name: 'Omar' } },
    ];
    const html = renderDigestHtml(model({ entries }));
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('style="');
    expect(html).toContain(DIGEST_ATTACHMENT_SENTENCE);
    // Summary counts, then names + days left only — never a second copy of the table.
    expect(html).toContain('Expired: 1');
    expect(html).toContain('Today: 1');
    expect(html).toContain('Next 7: 1');
    expect(html).toContain('Total: 3');
    expect(html).toContain('Ali');
    expect(html).toContain('Expired 3 days ago');
    expect(html).toContain('Expires today');
    expect(html).toContain('5 days left');
    expect(html).toContain('Report date: 26/10/2026 14:05 (Asia/Muscat)');
    expect(html).toContain('DKS-expiry-report-2026-10-26.pdf');
    expect(html).not.toContain('<table');
  });

  it('renders a short plain-text fallback', () => {
    const entries = [{ id: 'a', expiry: '2026-10-23', data: { full_name: 'Ali' } }];
    const text = renderDigestText(model({ entries, includeFullIds: false }));
    expect(text).toContain('DKS Daily Expiry Report');
    expect(text).toContain('Report date: 26/10/2026 14:05 (Asia/Muscat)');
    expect(text).toContain(DIGEST_ATTACHMENT_SENTENCE);
    expect(text).toContain('Ali');
    expect(text).toContain('Expired 3 days ago');
    expect(text).toContain('Passport and Civil ID values are masked');
    expect(text).toContain('Attachment: DKS-expiry-report-2026-10-26.pdf');
    // The table is only in the PDF: no column headers in the body.
    expect(text).not.toContain('Passport No');
  });

  it('explains the empty day without inventing rows', () => {
    const report = model({ entries: [] });
    const text = renderDigestText(report);
    expect(text).toContain(DIGEST_EMPTY_HEADLINE);
    expect(text).toContain(EMPTY_DAY_NOTE);
    expect(text).not.toContain('Passport');
    expect(renderDigestHtml(report)).toContain('All clear');
    expect(report.summary.total).toBe(0);
  });

  it('prints the five summary counts in a fixed order', () => {
    const report = model({ entries: bandEntries() });
    expect(summaryCountItems(report)).toEqual([
      { label: 'Expired', value: 1 },
      { label: 'Today', value: 1 },
      { label: 'Next 7', value: 1 },
      { label: 'Next 30', value: 2 },
      { label: 'Total', value: 4 },
    ]);
    expect(summaryLine(report)).toBe('Expired: 1 · Today: 1 · Next 7: 1 · Next 30: 2 · Total: 4');
    expect(reportDateTimeLabel(report)).toBe('26/10/2026 14:05 (Asia/Muscat)');
  });

  it('builds the attachment filename from the Muscat report date', () => {
    expect(pdfAttachmentFileName('2026-10-26')).toBe('DKS-expiry-report-2026-10-26.pdf');
  });
});

describe('PDF rendering', () => {
  const manyRows = (count: number, extra: Record<string, unknown> = {}) => Array.from(
    { length: count },
    (_, index) => ({
      id: `r${index}`,
      expiry: '2026-11-01',
      data: { full_name: `Row ${index}`, ...extra },
    }),
  );

  it('emits a valid PDF and reports every page', () => {
    const { bytes, pages } = renderToBytes(model({ entries: manyRows(120) }));
    expect(pages).toBeGreaterThan(1);
    const header = new TextDecoder('latin1').decode(bytes.slice(0, 4));
    expect(header).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('produces a LANDSCAPE A4 page (pt), not portrait millimetres', () => {
    expect(PDF_DOCUMENT_OPTIONS).toEqual({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const { bytes } = renderToBytes(model({ entries: manyRows(3) }));
    const text = new TextDecoder('latin1').decode(bytes);
    // 841.89 x 595.28 pt = A4 rotated. Portrait (or a mm page) fails here.
    expect(text).toMatch(/\/MediaBox\s*\[0 0 841\.\d+ 595\.\d+\]/);
    expect(sendEmailSource).toContain('PDF_DOCUMENT_OPTIONS');
  });

  it('is a single page with the calm message when nothing qualifies', () => {
    const { bytes, pages } = renderToBytes(model({ entries: [] }));
    expect(pages).toBe(1);
    const text = renderWithRecording(model({ entries: [] })).allText();
    expect(text).toContain('All clear');
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 4))).toBe('%PDF');
  });

  it('paginates and prints Page X of Y footers', () => {
    const doc = renderWithRecording(model({ entries: manyRows(120) }));
    expect(doc.pages).toBeGreaterThan(1);
    const footers = doc.allText().split('\n').filter((line) => line.startsWith('Page '));
    expect(footers.length).toBeGreaterThan(1);
    expect(footers[0]).toMatch(/^Page 1 of \d+$/);
    expect(new Set(footers.map((line) => line.split(' of ')[1])).size).toBe(1);
  });

  it('repeats the header row on every page', () => {
    const doc = renderWithRecording(model({
      entries: manyRows(120, { notes: 'a reasonably long note that should wrap onto several lines' }),
    }));
    expect(doc.pages).toBeGreaterThan(1);
    const headerDraws = doc.records
      .filter((record) => record.kind === 'text' && record.text === 'Full Name').length;
    // One header row per page, including the pages that only continue rows.
    expect(headerDraws).toBe(doc.pages);
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
    // The cell wraps (and hard-splits if needed), so every character survives.
    const drawn = doc.allText().match(/n+/g) ?? [];
    const total = drawn.reduce((sum, run) => sum + run.length, 0);
    expect(total).toBeGreaterThanOrEqual(300);
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

  it('says identifiers are masked and lists every active column as a header', () => {
    const entries = [{ id: 'a', expiry: '2026-11-01', data: { full_name: 'Ali', passport_no: 'P1234567' } }];
    const doc = renderWithRecording(model({ entries, includeFullIds: false }));
    const text = doc.allText();
    expect(text).toContain('Passport and Civil ID values are masked');
    // Every active column is a grid header, in the sheet's saved order.
    for (const header of ['Record', 'Full Name', 'Passport No', 'Civil ID', 'Visa Expiry', 'Fee', 'Active', 'Notes', 'Expiry', 'Days left', 'Status']) {
      expect(text).toContain(header);
    }
  });

  it('states the 200-row cap on the last page instead of dropping rows silently', () => {
    const doc = renderWithRecording(model({ entries: manyRows(205), totalQualifying: 230 }));
    expect(doc.allText()).toContain('most urgent of 230');
  });

  it('notes a currency symbol the PDF font cannot encode', () => {
    expect(currencyFallbackNote(model({ entries: bandEntries() })))
      .toMatch(/amounts show the OMR code/);
    const doc = renderWithRecording(model({ entries: bandEntries() }));
    expect(doc.allText()).toContain('amounts show the OMR code');
    expect(doc.allText()).toContain('OMR 12.500');
    expect(doc.allText()).not.toContain('????');
  });

  it('notes characters the font had to replace', () => {
    const entries = [{ id: 'a', expiry: '2026-11-01', data: { full_name: 'عمر' } }];
    const doc = renderWithRecording(model({ entries }));
    expect(doc.allText()).toContain("cannot be encoded by the PDF font and are shown as '?'");
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
    expect(built.html).toContain(DIGEST_ATTACHMENT_SENTENCE);
    expect(built.model?.includeFullIds).toBe(false);
  });

  it('defaults to FULL identifiers when the queued payload predates the flag', () => {
    const legacy = buildOutboxEmail({
      kind: 'expiry_digest',
      payload: {
        reportDate: '2026-10-26',
        columns: makeColumns(),
        entries: [{ id: 'a', expiry: '2026-11-01', data: { full_name: 'Ali', passport_no: 'P1234567' } }],
      },
    })!;
    // No includeFullIds key at all → the Admin-only PDF still gets the numbers…
    expect(legacy.model?.includeFullIds).toBe(true);
    expect(renderWithRecording(legacy.model!).allText()).toContain('P1234567');
    // …while the email body never does, whatever the flag says.
    expect(legacy.html).not.toContain('P1234567');
    expect(legacy.text).not.toContain('P1234567');
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

describe('Excel-like landscape grid', () => {
  it('has one row per record and every visible column in the saved order', () => {
    const report = model({ entries: bandEntries() });
    const columns = buildGridColumns(report);
    // Record label, then each visible Visa Sheet column in `position` order.
    expect(columns.map((column) => column.header)).toEqual([
      'Record', 'Full Name', 'Passport No', 'Civil ID', 'Visa Expiry', 'Fee', 'Active', 'Notes',
      'Expiry', 'Days left', 'Status',
    ]);
    const table = buildGridTable(report);
    expect(table.rows).toHaveLength(4);
    for (const row of table.rows) {
      expect(row.cells).toHaveLength(columns.length);
    }
  });

  it('prints DD/MM/YYYY expiry and sentence-form days left in separate columns', () => {
    const report = model({ entries: bandEntries() });
    const doc = renderWithRecording(report);
    const text = doc.allText();
    expect(text).toContain('Expiry');
    expect(text).toContain('Days left');
    expect(text).toContain('Status');
    expect(text).toContain('23/10/2026');
    expect(text).toContain('Expired 3 days ago');
    expect(text).toContain('Expires today');
    expect(text).toContain('5 days left');
    expect(text).toContain('12 days left');
  });

  it('shades alternate rows', () => {
    const doc = renderWithRecording(model({ entries: bandEntries() }));
    const fills = doc.records.filter((record) => record.kind === 'rect' && record.style === 'F');
    const rowBands = fills.filter((record) => String(record.fill) === String([249, 250, 251]));
    // Rows 1 and 3 (0-based odd indexes) carry the alternate grey band.
    expect(rowBands.length).toBe(2);
    for (const band of rowBands) {
      expect(Number(band.h)).toBeGreaterThan(8);
    }
  });

  it('colours expired/today red, 1–7 amber and the rest neutral', () => {
    const doc = renderWithRecording(model({ entries: bandEntries() }));
    const red = doc.textsOfColor([179, 38, 30]).join(' | ');
    const darkRed = doc.textsOfColor([138, 28, 28]).join(' | ');
    const amber = doc.textsOfColor([138, 90, 0]).join(' | ');
    expect(darkRed).toContain('Expired');
    expect(red).toContain('Expires today');
    expect(amber).toContain('Expires in 5 days');
    // A 12-day row is neutral (the body text colour).
    expect(doc.textsOfColor([52, 56, 62]).join(' | ')).toContain('Expires in 12 days');
  });

  it('splits wide sheets into column groups and repeats the record name per group', () => {
    const wide = Array.from({ length: 26 }, (_, index) => ({
      id: `field_${index}`,
      name: `Field Number ${index}`,
      type: 'text' as ReportColumnType,
      position: index,
      visible: true,
    }));
    const entries = [0, 1, 2].map((row) => ({
      id: `r${row}`,
      expiry: '2026-11-01',
      data: { field_0: `Record ${row}` },
    }));
    const report = model({ columns: wide, entries });
    const table = buildGridTable(report);
    const groups = planGridGroups(new jsPDF(PDF_DOCUMENT_OPTIONS) as never, table);

    expect(groups.length).toBeGreaterThan(1);
    // Every group starts with the record-name column; continuations say so.
    expect(groups[0].columns[0].header).toBe('Record');
    for (const group of groups.slice(1)) {
      expect(group.columns[0].header).toBe('Record (continued)');
    }
    // No visible column is ever dropped, and none is printed twice.
    const printed = groups.flatMap((group) => group.columns.slice(1).map((column) => column.header));
    expect(printed).toEqual(table.columns.slice(1).map((column) => column.header));

    const doc = renderWithRecording(report);
    expect(doc.allText()).toContain('Visa Sheet columns continued');
    expect(doc.allText()).toContain('Record (continued)');
    // Each group repeats the record name for its rows.
    const labels = doc.records.filter((record) => record.kind === 'text' && record.text === 'Record 0');
    expect(labels.length).toBeGreaterThanOrEqual(groups.length);
  });

  it('prints the summary counts above the table', () => {
    const doc = renderWithRecording(model({ entries: bandEntries() }));
    const text = doc.allText();
    for (const label of ['Expired:', 'Today:', 'Next 7:', 'Next 30:', 'Total:']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('26/10/2026 14:05 (Asia/Muscat)');
  });

  it('keeps every group inside the landscape page width and wraps cells', () => {
    const wide = Array.from({ length: 14 }, (_, index) => ({
      id: `field_${index}`,
      name: `Field ${index}`,
      type: 'text' as ReportColumnType,
      position: index,
      visible: true,
    }));
    const report = model({
      columns: wide,
      entries: [{ id: 'r', expiry: '2026-11-01', data: { field_0: 'word '.repeat(40).trim() } }],
    });
    const table = buildGridTable(report);
    for (const group of planGridGroups(new jsPDF(PDF_DOCUMENT_OPTIONS) as never, table)) {
      const total = group.widths.reduce((sum, width) => sum + width, 0);
      expect(total).toBeCloseTo(797.89, 1);
      for (const width of group.widths) {
        expect(width).toBeGreaterThan(10);
      }
    }
  });
});

describe('days-left wording', () => {
  it('spells each band out in words', () => {
    expect(formatDaysLeft(-3)).toBe('Expired 3 days ago');
    expect(formatDaysLeft(-1)).toBe('Expired 1 day ago');
    expect(formatDaysLeft(0)).toBe('Expires today');
    expect(formatDaysLeft(1)).toBe('1 day left');
    expect(formatDaysLeft(12)).toBe('12 days left');
  });

  it('keeps the terse status text alongside it', () => {
    const entries = [
      { id: 'a', expiry: '2026-10-23', data: {} },
      { id: 'b', expiry: '2026-10-26', data: {} },
      { id: 'c', expiry: '2026-10-27', data: {} },
      { id: 'd', expiry: '2026-11-07', data: {} },
    ];
    const selected = selectReportEntries(entries, makeColumns(), '2026-10-26');
    expect(selected.map((entry) => entry.status)).toEqual([
      'Expired', 'Expires today', 'Expires in 1 day', 'Expires in 12 days',
    ]);
    expect(selected.map((entry) => formatDaysLeft(entry.daysLeft))).toEqual([
      'Expired 3 days ago', 'Expires today', '1 day left', '12 days left',
    ]);
  });
});

describe('attachment payload', () => {
  it('names the attachment from the Muscat report date', () => {
    const report = model({ entries: bandEntries() });
    expect(report.pdfFileName).toBe('DKS-expiry-report-2026-10-26.pdf');
    expect(pdfAttachmentFileName('2026-12-31')).toBe('DKS-expiry-report-2026-12-31.pdf');
  });

  it('base64-encodes the real PDF bytes (application/pdf shape)', () => {
    const report = model({ entries: bandEntries() });
    const { bytes } = renderToBytes(report);
    const base64 = bytesToBase64(bytes);
    expect(base64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(base64.length % 4).toBe(0);
    const decoded = new TextDecoder('latin1').decode(
      Uint8Array.from(Buffer.from(base64, 'base64')),
    );
    expect(decoded.slice(0, 4)).toBe('%PDF');
    expect(decoded.length).toBe(bytes.length);
    // The Edge Function sends exactly this shape through Resend.
    expect(sendEmailSource).toContain('content_type: \'application/pdf\'');
    expect(sendEmailSource).toContain('content: bytesToBase64(bytes)');
  });
});

describe('full-identifier defaults in SQL and repo hygiene', () => {
  const schema = readFileSync(resolve(__dirname, '../supabase/schema.sql'), 'utf8');
  const migrationPath = resolve(__dirname, '../ARENA/sql/digest-full-columns.sql');
  const migration = readFileSync(migrationPath, 'utf8');

  it('defaults include_full_ids to true in the fresh-install schema', () => {
    expect(schema).toMatch(/'include_full_ids', true/);
    expect(schema).not.toMatch(/'include_full_ids', false/);
    // The builder also defaults to the "full" read of the preference.
    expect(schema).toMatch(/coalesce\(\(v_prefs ->> 'include_full_ids'\)::boolean, true\)/);
  });

  it('ships an idempotent migration that turns the live preference on', () => {
    expect(migration).toContain('begin;');
    expect(migration).toContain('commit;');
    expect(migration).toMatch(/update public\.settings[\s\S]*?'include_full_ids', true/);
    expect(migration).toContain('on conflict (key) do nothing');
    expect(migration).toMatch(/coalesce\(\(v_prefs ->> 'include_full_ids'\)::boolean, true\)/);
    // Additive only: no policy, trigger, cron or table change.
    const statements = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .toLowerCase();
    expect(statements).not.toMatch(/create policy|drop policy|alter policy/);
    expect(statements).not.toMatch(/create trigger|drop trigger|cron\.schedule|cron\.unschedule/);
    expect(statements).not.toMatch(/create table|alter table|drop table/);
  });

  it('ignores the temporary deploy copy of the edge functions', () => {
    const gitignore = readFileSync(resolve(__dirname, '../.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^supabase\/functions\/$/m);
  });

  it('keeps the .ts extension on the digest module imports (deploy guard)', () => {
    for (const file of ['_shared/digest-report.ts', '_shared/digest-pdf.ts', '_shared/outbox-email.ts', 'send-email/index.ts']) {
      const source = readFileSync(join(edgeFunctionsDir, file), 'utf8');
      for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
        expect(match[1], `${file} import ${match[1]}`).toMatch(/\.ts$/);
      }
    }
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
