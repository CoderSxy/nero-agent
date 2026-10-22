function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

/** Local calendar hours, including 23-hour and 25-hour daylight-saving days. */
export function expectedLocalHours(date: string, timeZone: string): number {
  const noon = Date.parse(`${date}T12:00:00Z`);
  let count = 0;
  for (let instant = noon - 36 * 3_600_000; instant < noon + 36 * 3_600_000; instant += 3_600_000) {
    if (localDate(new Date(instant), timeZone) === date) count += 1;
  }
  return count;
}

export function dailyHumidityMean(input: {
  date: string;
  timeZone: string;
  times: readonly string[];
  values: ReadonlyArray<number | null>;
}): number | null {
  if (input.times.length !== input.values.length) return null;
  const rows = input.times.map((time, index) => ({ time, value: input.values[index] }))
    .filter(row => row.time.startsWith(`${input.date}T`));
  if (rows.length !== expectedLocalHours(input.date, input.timeZone)) return null;
  const expected = new Map<string, number>();
  const noon = Date.parse(`${input.date}T12:00:00Z`);
  const hourFormat = new Intl.DateTimeFormat('en-GB', {timeZone:input.timeZone,hour:'2-digit',hourCycle:'h23'});
  for (let instant=noon-36*3_600_000; instant<noon+36*3_600_000; instant+=3_600_000) {
    const date = new Date(instant);
    if (localDate(date,input.timeZone) !== input.date) continue;
    const hour=hourFormat.format(date); expected.set(hour,(expected.get(hour)??0)+1);
  }
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00(?::00)?$/.test(row.time)) return null;
    const hour=row.time.slice(11,13), count=expected.get(hour)??0;
    if (!count) return null;
    expected.set(hour,count-1);
  }
  if ([...expected.values()].some(count=>count!==0)) return null;
  if (rows.some(row => typeof row.value !== 'number' || row.value < 0 || row.value > 100)) return null;
  const total = rows.reduce((sum, row) => sum + (row.value as number), 0);
  return Math.round((total / rows.length) * 10) / 10;
}
