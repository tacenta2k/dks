import { formatBusinessDateTime, formatDisplayDate, isValidIsoDate } from '../../lib/date';
import type { NotificationRecord } from './alert-service';

/** The date already associated with this record disambiguates legacy US text. */
function knownCalendarDate(record: NotificationRecord): string | null {
  if (record.kind === 'expiry') return isValidIsoDate(record.expiryValue) ? record.expiryValue : null;
  if (record.kind === 'daily-summary' || record.kind === 'weekly-summary') {
    return isValidIsoDate(record.summaryDate) ? record.summaryDate : null;
  }
  const businessDate = formatBusinessDateTime(record.createdAt).slice(0, 10);
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(businessDate);
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : '';
  return isValidIsoDate(iso) ? iso : null;
}

/**
 * Format dates in generated AND persisted legacy notification text. A stored
 * MM/DD/YYYY spelling is converted using the record's actual ISO date, so an
 * ambiguous 03/04/2026 is not guessed when its meaning is known. Unknown,
 * already-DD/MM text is preserved rather than silently swapping dates.
 */
export function formatNotificationText(text: string, record: NotificationRecord): string {
  let result = text;
  if (record.kind === 'office-delete') {
    // The server's generated deletion message contains its SQL timestamp.
    // Render that event in Muscat, rather than the DB/PC default timezone.
    const timestamp = formatBusinessDateTime(record.createdAt);
    if (/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(timestamp)) {
      result = result.replace(
        /^(Office deleted [\s\S]+? on )(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2})$/i,
        (_match, prefix: string) => `${prefix}${timestamp}`,
      );
    }
  }

  const known = knownCalendarDate(record);
  // Older delete messages used the database's UTC date. The event instant is
  // authoritative when that date differs from the Muscat business date.
  const instant = record.kind === 'office-delete' ? new Date(record.createdAt) : null;
  const utcEventDate = instant && !Number.isNaN(instant.getTime()) ? instant.toISOString().slice(0, 10) : null;
  result = result.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (iso) => {
    if (known && utcEventDate && iso === utcEventDate) return formatDisplayDate(known);
    return isValidIsoDate(iso) ? formatDisplayDate(iso) : iso;
  });
  return result.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (match, a: string, b: string, year: string) => {
    const first = Number(a);
    const second = Number(b);
    for (const candidate of [known, utcEventDate]) {
      if (!candidate || !known) continue;
      const [knownYear, knownMonth, knownDay] = candidate.split('-').map(Number);
      if (Number(year) === knownYear && (
        (first === knownMonth && second === knownDay)
        || (first === knownDay && second === knownMonth)
      )) return formatDisplayDate(known);
    }
    if (first <= 12 && second > 12) {
      const iso = `${year}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
      if (isValidIsoDate(iso)) return formatDisplayDate(iso);
    }
    // Ambiguous unknown dates may already be DD/MM: do not guess their order.
    return formatDisplayDate(match);
  });
}

/** Shared by the desktop notification bridge, including old stored text. */
export function notificationOsContent(record: NotificationRecord): { title: string; body: string } {
  const title = formatNotificationText(record.title, record);
  let body = formatNotificationText(record.body, record);
  const iso = knownCalendarDate(record);
  if (iso && record.kind !== 'office-delete') {
    const date = formatDisplayDate(iso);
    if (!body.includes(date)) body = `${body} · ${date}`;
  }
  return { title, body };
}
