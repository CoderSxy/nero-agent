import assert from 'node:assert/strict';
import test from 'node:test';
import { dailyHumidityMean } from '../src/mastra/agents/weather/aggregate';

test('a 25-hour daylight-saving day needs every local hour before averaging humidity', () => {
  // Europe/Berlin repeats 02:00; 24:00 is not a 25th local hour.
  const hours = [0, 1, 2, 2, ...Array.from({length:21}, (_,i)=>i+3)];
  const times = hours.map(hour => `2026-10-25T${String(hour).padStart(2, '0')}:00`);
  assert.equal(dailyHumidityMean({
    date: '2026-10-25', timeZone: 'Europe/Berlin', times, values: Array.from({ length: 25 }, () => 60),
  }), 60);
  assert.equal(dailyHumidityMean({
    date: '2026-10-25', timeZone: 'Europe/Berlin', times: times.slice(0, 24), values: Array.from({ length: 24 }, () => 60),
  }), null);
});
