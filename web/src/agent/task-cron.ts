export type CronPreset =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; hour: number; minute: number; weekday: number }
  | { kind: 'monthly'; hour: number; minute: number; day: number }
  | { kind: 'custom'; expression: string };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildTaskCron(preset: CronPreset, _timezone: string): string {
  void _timezone;
  if (preset.kind === 'custom') return preset.expression.trim();
  const minute = clamp(preset.minute, 0, 59);
  const hour = clamp(preset.hour, 0, 23);
  if (preset.kind === 'daily') return `${minute} ${hour} * * *`;
  if (preset.kind === 'weekly') {
    const weekday = clamp(preset.weekday, 0, 6);
    return `${minute} ${hour} * * ${weekday}`;
  }
  const day = clamp(preset.day, 1, 31);
  return `${minute} ${hour} ${day} * *`;
}

export function parseTaskCron(cron: string): CronPreset {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { kind: 'custom', expression: cron.trim() };
  const [minutePart, hourPart, dayPart, monthPart, weekPart] = parts;
  const minute = Number(minutePart);
  const hour = Number(hourPart);
  if (!Number.isInteger(minute) || !Number.isInteger(hour) || monthPart !== '*') {
    return { kind: 'custom', expression: cron.trim() };
  }
  if (dayPart === '*' && weekPart === '*') {
    return { kind: 'daily', hour, minute };
  }
  if (dayPart === '*' && /^\d+$/.test(weekPart)) {
    return { kind: 'weekly', hour, minute, weekday: Number(weekPart) };
  }
  if (weekPart === '*' && /^\d+$/.test(dayPart)) {
    return { kind: 'monthly', hour, minute, day: Number(dayPart) };
  }
  return { kind: 'custom', expression: cron.trim() };
}

export function cronLabel(cron: string): string {
  const parsed = parseTaskCron(cron);
  const pad = (value: number) => String(value).padStart(2, '0');
  if (parsed.kind === 'daily') return `每天 ${pad(parsed.hour)}:${pad(parsed.minute)}`;
  if (parsed.kind === 'weekly') {
    const names = ['日', '一', '二', '三', '四', '五', '六'];
    return `每周${names[parsed.weekday] ?? parsed.weekday} ${pad(parsed.hour)}:${pad(parsed.minute)}`;
  }
  if (parsed.kind === 'monthly') {
    return `每月 ${parsed.day} 日 ${pad(parsed.hour)}:${pad(parsed.minute)}`;
  }
  return parsed.expression;
}
