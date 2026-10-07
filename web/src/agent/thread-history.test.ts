import { describe, expect, it } from 'vitest';
import { formatThreadTime, groupThreadsByTime } from './thread-history';

const now = new Date(2026, 9, 7, 12);

describe('thread history dates', () => {
  it('groups local calendar days without changing the order inside each group', () => {
    const items = [
      { id: 'today', updatedAt: '2026-10-07T09:00:00' },
      { id: 'yesterday', updatedAt: '2026-10-06T23:59:00' },
      { id: 'week', updatedAt: '2026-10-01T09:00:00' },
      { id: 'month', updatedAt: '2026-09-20T09:00:00' },
      { id: 'old', updatedAt: '2026-08-01T09:00:00' },
      { id: 'unknown', updatedAt: 'invalid' },
    ];
    expect(groupThreadsByTime(items, now).map(group => [group.label, group.items.map(item => item.id)]))
      .toEqual([
        ['今天', ['today']], ['昨天', ['yesterday']], ['7 天内', ['week']],
        ['30 天内', ['month']], ['2026-08', ['old']], ['未知时间', ['unknown']],
      ]);
  });

  it('formats a relative time for the ordinary list', () => {
    expect(formatThreadTime('2026-10-07T11:45:00', now)).toBe('15 分');
    expect(formatThreadTime('2026-10-06T09:00:00', now)).toBe('昨天');
  });
});
