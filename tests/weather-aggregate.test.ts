import assert from 'node:assert/strict';
import test from 'node:test';
import { dailyHumidityMean } from '../src/mastra/agents/weather/aggregate';

test('a 25-hour daylight-saving day needs every local hour before averaging humidity', () => {
  const times = Array.from({ length: 25 }, (_unused, index) => `2026-10-25T${String(index).padStart(2, '0')}:00`);
  assert.equal(dailyHumidityMean({
    date: '2026-10-25', timeZone: 'Europe/Berlin', times, values: Array.from({ length: 25 }, () => 60),
  }), 60);
  assert.equal(dailyHumidityMean({
    date: '2026-10-25', timeZone: 'Europe/Berlin', times: times.slice(0, 24), values: Array.from({ length: 24 }, () => 60),
  }), null);
});
