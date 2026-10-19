import { isTimezone } from './context';

const MAX_CALENDAR_DAYS = 3660;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || value.startsWith('0000')) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

/** UTC is only a carrier for date-only arithmetic, never the requested timezone's elapsed hours. */
export function calendarDates(startDate: string, endDate: string): string[] {
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) throw new Error('Invalid calendar date');
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const count = (end.getTime() - start.getTime()) / 86_400_000 + 1;
  if (count < 1 || count > MAX_CALENDAR_DAYS) throw new Error('Invalid or excessive calendar range');
  const result: string[] = [];
  for (let index = 0; index < count; index++) {
    result.push(start.toISOString().slice(0, 10));
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return result;
}

export type DatedRow = { date: string; [key: string]: unknown };
export type DateCoverageIssue = {
  code: 'INVALID_REQUEST' | 'INVALID_DATE' | 'DATE_RANGE_MISMATCH' | 'MISSING_DATES'
    | 'DUPLICATE_DATES' | 'MISSING_VALUES' | 'INVALID_VALUES' | 'TIMEZONE_MISMATCH';
  dates?: string[];
  fields?: string[];
};
export type DateCoverageResult<T extends DatedRow> = {
  startDate: string;
  endDate: string;
  timezone: string;
  expectedDates: string[];
  actualDates: string[];
  rows: T[];
} & ({ ok: true; status: 'complete'; issues: [] }
  | { ok: false; status: 'partial' | 'invalid'; issues: DateCoverageIssue[] });

/** An integration helper, not an automatic validator of unstructured model replies. */
export function validateDateCoverage<T extends DatedRow>(input: {
  startDate: string;
  endDate: string;
  timezone: string;
  sourceTimezone?: string;
  rows: T[];
  requiredNumericFields?: string[];
}): DateCoverageResult<T> {
  const { startDate, endDate, timezone, sourceTimezone, rows, requiredNumericFields = [] } = input;
  const issues: DateCoverageIssue[] = [];
  let expectedDates: string[] = [];
  try {
    if (!isTimezone(timezone)) throw new Error('Invalid timezone');
    expectedDates = calendarDates(startDate, endDate);
  } catch {
    return { ok: false, status: 'invalid', startDate, endDate, timezone,
      expectedDates, actualDates: [], rows: [], issues: [{ code: 'INVALID_REQUEST' }] };
  }
  if (sourceTimezone !== undefined) {
    if (!isTimezone(sourceTimezone) || new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone
      !== new Intl.DateTimeFormat('en', { timeZone: sourceTimezone }).resolvedOptions().timeZone) {
      issues.push({ code: 'TIMEZONE_MISMATCH' });
    }
  }
  const validRows: T[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    if (!row || !isCalendarDate(row.date)) {
      issues.push({ code: 'INVALID_DATE' });
      continue;
    }
    if (seen.has(row.date)) duplicates.add(row.date);
    seen.add(row.date);
    validRows.push(row);
    const missing = requiredNumericFields.filter(field => row[field] == null);
    const invalid = requiredNumericFields.filter(field => row[field] != null
      && (typeof row[field] !== 'number' || !Number.isFinite(row[field])));
    if (missing.length) issues.push({ code: 'MISSING_VALUES', dates: [row.date], fields: missing });
    if (invalid.length) issues.push({ code: 'INVALID_VALUES', dates: [row.date], fields: invalid });
  }
  if (duplicates.size) issues.push({ code: 'DUPLICATE_DATES', dates: [...duplicates].sort() });
  const expected = new Set(expectedDates);
  const missingDates = expectedDates.filter(date => !seen.has(date));
  if (missingDates.length) issues.push({ code: 'MISSING_DATES', dates: missingDates });
  const unexpected = [...seen].filter(date => !expected.has(date)).sort();
  if (unexpected.length) issues.push({ code: 'DATE_RANGE_MISMATCH', dates: unexpected });
  const base = { startDate, endDate, timezone, expectedDates, actualDates: [...seen].sort(),
    rows: validRows.slice().sort((a, b) => a.date.localeCompare(b.date)) };
  if (!issues.length) return { ...base, ok: true, status: 'complete', issues: [] };
  const partial = issues.every(issue => issue.code === 'MISSING_DATES' || issue.code === 'MISSING_VALUES');
  return { ...base, ok: false, status: partial ? 'partial' : 'invalid', issues };
}
