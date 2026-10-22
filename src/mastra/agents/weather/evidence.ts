import { weatherCodeLabel } from './codes';
import { dailyHumidityMean } from './aggregate';
import { canonicalUnit, type WeatherFieldSource, type WeatherMetric, type WeatherSubmission } from './types';

export type WeatherEvidence = { url: string; value: unknown };

export type WeatherAssessment = {
  valid: boolean;
  complete: boolean;
  missing: string[];
  reason?: 'invalid-data' | 'unverified-source';
};

function atPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asNumbers(values: unknown[]): Array<number | null> | null {
  const numbers = values.map(value => value === null ? null : typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN);
  return numbers.some(value => Number.isNaN(value)) ? null : numbers;
}

function alignedSeries(record: unknown, dateField: string, valueField: string): { dates: string[]; values: Array<number | null> } | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const dates = (record as Record<string, unknown>)[dateField];
  const values = (record as Record<string, unknown>)[valueField];
  if (!Array.isArray(dates) || !Array.isArray(values) || dates.length !== values.length) return null;
  if (!dates.every(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(date))) return null;
  const numbers = asNumbers(values);
  if (!numbers) return null;
  return { dates: dates.map(date => String(date).slice(0, 10)), values: numbers };
}

function unitOf(root: unknown, source: WeatherFieldSource): string | null {
  const record = atPath(root, source.recordPath);
  if (source.unitField && record && typeof record === 'object' && !Array.isArray(record)) {
    const direct = (record as Record<string, unknown>)[source.unitField];
    if (typeof direct === 'string') return direct;
  }
  const parent = atPath(root, source.recordPath.slice(0, -1));
  const leaf = source.recordPath.at(-1);
  const units = parent && leaf && typeof parent === 'object' ? (parent as Record<string, unknown>)[`${leaf}_units`] : undefined;
  if (source.unitField && units && typeof units === 'object' && !Array.isArray(units)) {
    const value = (units as Record<string, unknown>)[source.valueField];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function samePlace(root: unknown, submission: WeatherSubmission): boolean {
  const weather = submission.weather;
  if (!weather || !root || typeof root !== 'object') return false;
  const record = root as Record<string, unknown>;
  return record.timezone === weather.timezone
    && Math.abs(Number(record.latitude) - weather.location.latitude) < 0.05
    && Math.abs(Number(record.longitude) - weather.location.longitude) < 0.05;
}

function userSupplied(source: WeatherFieldSource, userText: string, dates: readonly string[], values: readonly Array<number | null>): boolean {
  if (source.sourceUrl !== '') return false;
  if (!dates.every(date => userText.includes(date))) return false;
  const listed = values.filter((value): value is number => value !== null).join(',');
  return listed.length > 0 && userText.replace(/\s+/g, '').includes(listed);
}

function fail(reason: WeatherAssessment['reason'], missing: string): WeatherAssessment {
  return { valid: false, complete: false, missing: [missing], reason };
}

export function assessWeatherSubmission(submission: WeatherSubmission, evidence: readonly WeatherEvidence[], userText = ''): WeatherAssessment {
  if (submission.status === 'insufficient-data' || !submission.dataset || !submission.weather) {
    return { valid: true, complete: false, missing: ['weather.data'] };
  }
  const weather = submission.weather;
  const data = submission.dataset;
  if (JSON.stringify(data.categories) !== JSON.stringify(weather.dates) || weather.weatherCodes.length !== weather.dates.length) {
    return fail('invalid-data', 'weather.range');
  }
  if (data.series.some(series => series.values.length !== data.categories.length)) return fail('invalid-data', 'weather.range');
  const high = data.series.find(series => series.metric === 'temperature-max');
  const low = data.series.find(series => series.metric === 'temperature-min');
  if (high && low && high.values.some((value, index) => value !== null && low.values[index] !== null && (low.values[index] as number) > value)) {
    return fail('invalid-data', 'weather.temperature');
  }
  const missing: string[] = [];
  for (const source of weather.fieldSources) {
    if (source.kind === 'user') {
      const submitted = source.metric === 'weather-code'
        ? weather.weatherCodes
        : data.series.find(series => series.metric === source.metric)?.values;
      if (!submitted || !userSupplied(source, userText, weather.dates, submitted)) return fail('unverified-source', source.metric);
      continue;
    }
    const found = source.kind === 'url' ? evidence.find(item => item.url === source.sourceUrl) : undefined;
    if (source.kind === 'url' && !found) return fail('unverified-source', source.metric);
    if (source.kind === 'url' && found && !samePlace(found.value, submission)) return fail('unverified-source', 'weather.location');
    const root = source.kind === 'user' ? { text: userText } : found?.value;
    if (source.transform === 'humidity-hourly-daily-mean') {
      if (source.metric !== 'humidity-mean') return fail('invalid-data', 'weather.humidity');
      const record = atPath(root, source.recordPath);
      const times = record && typeof record === 'object' ? (record as Record<string, unknown>)[source.dateField] : undefined;
      const values = record && typeof record === 'object' ? (record as Record<string, unknown>)[source.valueField] : undefined;
      if (!Array.isArray(times) || !Array.isArray(values)) return fail('invalid-data', 'weather.humidity');
      const means = weather.dates.map(date => dailyHumidityMean({
        date, timeZone: weather.timezone, times: times.map(String), values: values as Array<number | null>,
      }));
      const submitted = data.series.find(series => series.metric === 'humidity-mean')?.values;
      if (!submitted || JSON.stringify(submitted) !== JSON.stringify(means)) return fail('invalid-data', 'weather.humidity');
      if (means.some(value => value === null)) missing.push('weather.humidity');
      continue;
    }
    if (source.transform !== 'identity') return fail('invalid-data', source.metric);
    const aligned = alignedSeries(atPath(root, source.recordPath), source.dateField, source.valueField);
    const requirement = source.metric === 'weather-code' ? 'weather.condition' : source.metric;
    if (!aligned || JSON.stringify(aligned.dates) !== JSON.stringify(weather.dates)) return fail('invalid-data', requirement);
    if (source.metric === 'weather-code') {
      if (JSON.stringify(aligned.values) !== JSON.stringify(weather.weatherCodes)) return fail('invalid-data', 'weather.condition');
      continue;
    }
    const unit = unitOf(root, source);
    if (unit !== canonicalUnit(source.metric as WeatherMetric)) return fail('invalid-data', source.metric);
    const submitted = data.series.find(series => series.metric === source.metric)?.values;
    if (!submitted || JSON.stringify(submitted) !== JSON.stringify(aligned.values)) return fail('invalid-data', source.metric);
    if (aligned.values.some(value => value === null)) missing.push(source.metric);
    if (source.metric === 'precipitation-probability' && aligned.values.some(value => value !== null && (value < 0 || value > 100))) {
      return fail('invalid-data', 'weather.precipitation');
    }
    if ((source.metric === 'precipitation-amount' || source.metric === 'wind-speed-max') && aligned.values.some(value => value !== null && value < 0)) {
      return fail('invalid-data', source.metric);
    }
  }
  if (weather.weatherCodes.some(code => code !== null && weatherCodeLabel(code) === null)) missing.push('weather.condition');
  return { valid: true, complete: missing.length === 0, missing: [...new Set(missing)] };
}
