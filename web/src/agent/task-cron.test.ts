import { describe, expect, it } from 'vitest';
import { buildTaskCron, cronLabel, parseTaskCron } from './task-cron';

describe('task cron helpers', () => {
  it('builds daily weekly and monthly expressions', () => {
    expect(buildTaskCron({ kind: 'daily', hour: 9, minute: 0 }, 'Asia/Shanghai')).toBe('0 9 * * *');
    expect(buildTaskCron({ kind: 'weekly', hour: 8, minute: 30, weekday: 1 }, 'Asia/Shanghai')).toBe('30 8 * * 1');
    expect(buildTaskCron({ kind: 'monthly', hour: 10, minute: 15, day: 31 }, 'UTC')).toBe('15 10 31 * *');
  });

  it('round-trips presets and keeps custom expressions', () => {
    expect(parseTaskCron('0 9 * * *')).toEqual({ kind: 'daily', hour: 9, minute: 0 });
    expect(parseTaskCron('30 8 * * 1')).toEqual({ kind: 'weekly', hour: 8, minute: 30, weekday: 1 });
    expect(parseTaskCron('15 10 31 * *')).toEqual({ kind: 'monthly', hour: 10, minute: 15, day: 31 });
    expect(parseTaskCron('*/5 * * * *')).toEqual({ kind: 'custom', expression: '*/5 * * * *' });
    expect(buildTaskCron({ kind: 'custom', expression: '*/5 * * * *' }, 'UTC')).toBe('*/5 * * * *');
  });

  it('renders readable cron labels', () => {
    expect(cronLabel('0 9 * * *')).toContain('每天');
    expect(cronLabel('0 9 * * 1')).toContain('每周');
    expect(cronLabel('*/5 * * * *')).toBe('*/5 * * * *');
  });
});
