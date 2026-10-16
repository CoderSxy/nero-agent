function partsAt(instant: Date, timezone: string) {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const part = (kind: string) => Number(values.find((item) => item.type === kind)?.value);
  return { year: part('year'), month: part('month'), day: part('day'),
    hour: part('hour'), minute: part('minute'), second: part('second') };
}

export function toTaskLocalTime(iso: string, timezone: string): string {
  const parts = partsAt(new Date(iso), timezone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function fromTaskLocalTime(value: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('时间格式无效');
  const [, year, month, day, hour, minute] = match.map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let instant = target;
  for (let index = 0; index < 5; index += 1) {
    const parts = partsAt(new Date(instant), timezone);
    const observed = Date.UTC(parts.year, parts.month - 1, parts.day,
      parts.hour, parts.minute, parts.second);
    const delta = target - observed;
    if (delta === 0) return new Date(instant).toISOString();
    instant += delta;
  }
  throw new Error('所选时区中该时间不存在，请更换时间');
}
