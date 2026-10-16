import { describe, expect, it } from 'vitest';
import { fromTaskLocalTime, toTaskLocalTime } from './task-timezone';

describe('scheduled task time zone fields', () => {
  it('shows an ISO instant in the selected task time zone', () => {
    expect(toTaskLocalTime('2026-10-20T01:00:00.000Z', 'Asia/Shanghai'))
      .toBe('2026-10-20T09:00');
  });

  it('saves the selected wall time using the task time zone', () => {
    expect(fromTaskLocalTime('2026-10-20T09:00', 'Asia/Shanghai'))
      .toBe('2026-10-20T01:00:00.000Z');
    expect(fromTaskLocalTime('2026-07-01T09:00', 'America/New_York'))
      .toBe('2026-07-01T13:00:00.000Z');
  });

  it('rejects a wall time skipped by daylight saving', () => {
    expect(() => fromTaskLocalTime('2026-03-08T02:30', 'America/New_York'))
      .toThrow('不存在');
  });
});
