import { z } from 'zod';

export const weatherMetrics = [
  'temperature-max', 'temperature-min', 'precipitation-probability', 'precipitation-amount', 'humidity-mean', 'wind-speed-max',
] as const;
export type WeatherMetric = typeof weatherMetrics[number];

const metricUnits: Record<WeatherMetric, string> = {
  'temperature-max': '°C',
  'temperature-min': '°C',
  'precipitation-probability': '%',
  'precipitation-amount': 'mm',
  'humidity-mean': '%',
  'wind-speed-max': 'km/h',
};

export function canonicalUnit(metric: WeatherMetric): string {
  return metricUnits[metric];
}

export const weatherFieldSourceSchema = z.object({
  kind: z.enum(['url', 'user']),
  metric: z.enum([...weatherMetrics, 'weather-code']),
  sourceUrl: z.string().max(2000),
  recordPath: z.array(z.string().min(1).max(80)).max(8),
  dateField: z.string().min(1).max(80),
  valueField: z.string().min(1).max(80),
  unitField: z.string().min(1).max(80).nullable(),
  transform: z.enum(['identity', 'humidity-hourly-daily-mean']),
}).strict();

export const weatherPayloadSchema = z.object({
  location: z.object({
    name: z.string().min(1).max(120),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  }).strict(),
  timezone: z.string().min(1).max(80),
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(366),
  weatherCodes: z.array(z.number().int().nullable()).max(366),
  fieldSources: z.array(weatherFieldSourceSchema).min(1).max(12),
}).strict();

export const weatherSeriesSchema = z.object({
  name: z.string().min(1).max(100),
  unit: z.string().max(30),
  metric: z.enum(weatherMetrics),
  values: z.array(z.number().finite().nullable()).min(1).max(366),
}).strict();

export const weatherDatasetSchema = z.object({
  categories: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(366),
  series: z.array(weatherSeriesSchema).min(1).max(8),
  sources: z.array(z.object({
    kind: z.enum(['user', 'url']),
    label: z.string().min(1).max(200),
    url: z.string().max(2000),
  }).strict()).min(1).max(10),
}).strict();

export const weatherSubmissionSchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal('weather'),
  status: z.enum(['ready', 'insufficient-data']),
  reason: z.string().max(1000),
  title: z.string().max(200),
  dataset: weatherDatasetSchema.nullable(),
  weather: weatherPayloadSchema.nullable(),
}).strict();

export type WeatherSubmission = z.infer<typeof weatherSubmissionSchema>;
export type WeatherPayload = z.infer<typeof weatherPayloadSchema>;
export type WeatherFieldSource = z.infer<typeof weatherFieldSourceSchema>;
