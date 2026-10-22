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
  values: readonly Array<number | null>;
}): number | null {
  if (input.times.length !== input.values.length) return null;
  const rows = input.times.map((time, index) => ({ time, value: input.values[index] }))
    .filter(row => row.time.startsWith(`${input.date}T`));
  if (rows.length !== expectedLocalHours(input.date, input.timeZone)) return null;
  if (rows.some(row => typeof row.value !== 'number' || row.value < 0 || row.value > 100)) return null;
  const total = rows.reduce((sum, row) => sum + (row.value as number), 0);
  return Math.round((total / rows.length) * 10) / 10;
}
