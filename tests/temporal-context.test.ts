import assert from 'node:assert/strict';
import test from 'node:test';
import { createTemporalContext, formatTemporalContext } from '../src/mastra/temporal/context';

test('current date uses Shanghai calendar rather than the UTC date', () => {
  const context = createTemporalContext(new Date('2026-10-16T16:30:00.000Z'));
  assert.equal(context.date, '2026-10-17');
  assert.equal(context.weekday, '星期六');
  assert.equal(context.timezone, 'Asia/Shanghai');
  assert.equal(context.localDateTime, '2026-10-17T00:30:00+08:00');
  assert.match(formatTemporalContext(context), /2026-10-17/);
});

test('target timezone determines date and daylight-saving offset', () => {
  const context = createTemporalContext(new Date('2026-10-17T01:30:00Z'), 'America/New_York');
  assert.equal(context.date, '2026-10-16');
  assert.equal(context.localDateTime, '2026-10-16T21:30:00-04:00');
  assert.equal(createTemporalContext(new Date('2026-12-17T01:30:00Z'), 'America/New_York').localDateTime,
    '2026-12-16T20:30:00-05:00');
  assert.equal(createTemporalContext(new Date('2026-10-17T01:30:00Z'), 'Asia/Kathmandu').localDateTime,
    '2026-10-17T07:15:00+05:45');
});

test('invalid clocks and timezones fail instead of silently changing the date', () => {
  assert.throws(() => createTemporalContext(new Date('invalid')), /Invalid/);
  assert.throws(() => createTemporalContext(new Date(), 'invalid/timezone'), /timezone/i);
});
