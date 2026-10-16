import assert from 'node:assert/strict';
import test from 'node:test';
import { cronOccurrenceKey } from '../src/mastra/scheduled-tasks/validation';

test('cron occurrence key names the previous planned slot, not the next delivery slot', () => {
  assert.equal(cronOccurrenceKey('0 9 * * *', 'Asia/Shanghai',
    new Date('2026-10-14T01:00:03.000Z')), '2026-10-14T09:00:00');
  assert.equal(cronOccurrenceKey('0 9 * * *', 'Asia/Shanghai',
    new Date('2026-10-14T02:00:00.000Z')), '2026-10-14T09:00:00');
});
