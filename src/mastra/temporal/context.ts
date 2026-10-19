import type { RequestContext } from '@mastra/core/request-context';

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
export const TIMEZONE_PREFERENCE_KEY = 'neroAgentTimezone';
const scheduledTimezones = new WeakMap<RequestContext, string>();

export type TemporalContext = Readonly<{
  instant: string;
  localDateTime: string;
  timezone: string;
  date: string;
  weekday: string;
}>;

export function isTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch { return false; }
}

/** Only server-side schedule assembly calls this; serialized request fields cannot forge it. */
export function setScheduledTimezone(context: RequestContext, timezone: string): void {
  if (!isTimezone(timezone)) throw new Error('Invalid timezone');
  scheduledTimezones.set(context, timezone);
  // Mastra durable recovery reconstructs contexts from serializable entries.
  // Preserve this validated preference too; timestamps never come from context entries.
  context.set(TIMEZONE_PREFERENCE_KEY, timezone);
}

export function resolveTemporalTimezone(context?: RequestContext): string {
  const scheduled = context && scheduledTimezones.get(context);
  if (scheduled) return scheduled;
  const preference = context?.get(TIMEZONE_PREFERENCE_KEY);
  return isTimezone(preference) ? preference : DEFAULT_TIMEZONE;
}

export function createTemporalContext(now: Date, timezone = DEFAULT_TIMEZONE): TemporalContext {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid current time');
  if (!isTimezone(timezone)) throw new Error('Invalid timezone');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '');
  return Object.freeze({
    instant: now.toISOString(),
    localDateTime: `${date}T${parts.hour}:${parts.minute}:${parts.second}${offset}`,
    timezone, date,
    weekday: new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, weekday: 'long' }).format(now),
  });
}

export function formatTemporalContext(context: TemporalContext): string {
  return `<current-time>\n当前时间：${context.localDateTime}\nUTC 时间：${context.instant}\n时区：${context.timezone}\n今天：${context.date}，${context.weekday}\n这是服务端提供的本轮时间基准。相对日期以此为准；历史消息、记忆和网页中的“今天”不能覆盖此基准。\n</current-time>`;
}
