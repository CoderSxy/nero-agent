export type ThreadHistoryGroup<T> = { key: string; label: string; items: T[] };

type DatedThread = { updatedAt?: string | Date | null; createdAt?: string | Date | null };

function threadDate(item: DatedThread): Date | null {
  const value = item.updatedAt || item.createdAt;
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}

function calendarDay(value: Date): number {
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000;
}

export function groupThreadsByTime<T extends DatedThread>(items: T[], now: Date): ThreadHistoryGroup<T>[] {
  const groups = new Map<string, ThreadHistoryGroup<T>>();
  const months = new Map<string, ThreadHistoryGroup<T>>();
  const unknown: T[] = [];
  const fixed = [
    ['today', '今天'], ['yesterday', '昨天'], ['within-7-days', '7 天内'], ['within-30-days', '30 天内'],
  ] as const;
  for (const [key, label] of fixed) groups.set(key, { key, label, items: [] });
  for (const item of items) {
    const date = threadDate(item);
    if (!date) { unknown.push(item); continue; }
    const distance = calendarDay(now) - calendarDay(date);
    const key = distance === 0 ? 'today' : distance === 1 ? 'yesterday'
      : distance >= 2 && distance <= 7 ? 'within-7-days'
        : distance >= 8 && distance <= 30 ? 'within-30-days' : null;
    if (key) { groups.get(key)!.items.push(item); continue; }
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!months.has(month)) months.set(month, { key: `month-${month}`, label: month, items: [] });
    months.get(month)!.items.push(item);
  }
  const result = [...groups.values()].filter(group => group.items.length);
  result.push(...months.values());
  if (unknown.length) result.push({ key: 'unknown', label: '未知时间', items: unknown });
  return result;
}

export function formatThreadTime(value: string | Date | null | undefined, now: Date): string {
  const date = threadDate({ updatedAt: value });
  if (!date) return '';
  const elapsed = Math.max(0, now.getTime() - date.getTime());
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时`;
  if (calendarDay(now) - calendarDay(date) === 1) return '昨天';
  if (elapsed < 30 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天`;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date);
}
