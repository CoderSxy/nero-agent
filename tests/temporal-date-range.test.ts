import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarDates, isCalendarDate, validateDateCoverage } from '../src/mastra/temporal/date-range';

const request = { startDate: '2026-10-17', endDate: '2026-10-23', timezone: 'Asia/Shanghai' };
const dates = ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
const rows = dates.map((date, index) => ({ date, temperature: 20 + index }));
const codes = (result: ReturnType<typeof validateDateCoverage>) => result.issues.map(issue => issue.code);

test('calendar dates validate real dates and span leap days and year boundaries', () => {
  for (const invalid of ['2026-02-29', '2026-04-31', '2026-1-01', '2026-13-01', '0000-01-01', 'today']) {
    assert.equal(isCalendarDate(invalid), false, invalid);
  }
  assert.equal(isCalendarDate('2028-02-29'), true);
  assert.deepEqual(calendarDates('2028-02-28', '2028-03-01'), ['2028-02-28', '2028-02-29', '2028-03-01']);
  assert.deepEqual(calendarDates('2026-12-31', '2027-01-02'), ['2026-12-31', '2027-01-01', '2027-01-02']);
  assert.throws(() => calendarDates('2026-10-23', '2026-10-17'), /range/i);
  assert.throws(() => calendarDates('invalid', '2026-10-17'), /date/i);
  assert.throws(() => calendarDates('0001-01-01', '9999-12-31'), /range/i);
});

test('seven complete dates pass; sorting preserves each date/value pair and does not mutate inputs', () => {
  const shuffled = [rows[6], rows[0], ...rows.slice(1, 6)];
  const original = JSON.stringify(shuffled);
  const result = validateDateCoverage({ ...request, rows: shuffled, requiredNumericFields: ['temperature'] });
  assert.equal(result.status, 'complete');
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, rows);
  assert.deepEqual(result.issues, []);
  assert.equal(JSON.stringify(shuffled), original);
});

test('missing day and yesterday-based seven-day result are never complete', () => {
  const missing = validateDateCoverage({ ...request, rows: rows.slice(1) });
  assert.equal(missing.status, 'partial');
  assert.equal(missing.ok, false);
  assert.ok(codes(missing).includes('MISSING_DATES'));
  const shifted = validateDateCoverage({ ...request, rows: [{ date: '2026-10-16' }, ...rows.slice(0, 6)] });
  assert.ok(codes(shifted).includes('DATE_RANGE_MISMATCH'));
  assert.ok(codes(shifted).includes('MISSING_DATES'));
  assert.equal(shifted.ok, false);
});

test('duplicate and impossible dates fail even when there are seven rows', () => {
  const duplicate = validateDateCoverage({ ...request, rows: [...rows.slice(0, 6), rows[0]] });
  assert.equal(duplicate.status, 'invalid');
  assert.ok(codes(duplicate).includes('DUPLICATE_DATES'));
  const invalid = validateDateCoverage({ ...request, rows: [{ date: '2026-02-30' }] });
  assert.equal(invalid.status, 'invalid');
  assert.ok(codes(invalid).includes('INVALID_DATE'));
});

test('missing, null, nonnumeric and nonfinite required values do not pass coverage', () => {
  for (const value of [undefined, null, NaN, Infinity, '25']) {
    const result = validateDateCoverage({ ...request,
      rows: rows.map((row, index) => index === 0 ? { ...row, temperature: value } : row),
      requiredNumericFields: ['temperature'] });
    assert.equal(result.ok, false);
    assert.ok(codes(result).some(code => code === 'MISSING_VALUES' || code === 'INVALID_VALUES'));
  }
});

test('empty source is partial; invalid requests and conflicting timezones fail explicitly', () => {
  assert.equal(validateDateCoverage({ ...request, rows: [] }).status, 'partial');
  for (const input of [{ ...request, timezone: 'invalid' }, { ...request, endDate: '2026-10-01' }]) {
    assert.ok(codes(validateDateCoverage({ ...input, rows })).includes('INVALID_REQUEST'));
  }
  const mismatch = validateDateCoverage({ ...request, sourceTimezone: 'America/New_York', rows });
  assert.equal(mismatch.ok, false);
  assert.ok(codes(mismatch).includes('TIMEZONE_MISMATCH'));
});

test('local calendar coverage remains consecutive over daylight-saving transitions', () => {
  const result = validateDateCoverage({ startDate: '2026-03-07', endDate: '2026-03-09',
    timezone: 'America/New_York', rows: [{ date: '2026-03-07' }, { date: '2026-03-08' }, { date: '2026-03-09' }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.expectedDates, ['2026-03-07', '2026-03-08', '2026-03-09']);
});
