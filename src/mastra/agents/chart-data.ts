import { createHash } from 'node:crypto';
import { z } from 'zod';
import { matchesUserData, matchesStructuredData, type ChartEvidence } from './chart-evidence';
import { assessWeatherSubmission } from './weather/evidence';
import { weatherSubmissionSchema, type WeatherSubmission } from './weather/types';

export const chartDatasetSchema = z.object({
  categories: z.array(z.string().min(1).max(100)).min(1).max(366),
  series: z.array(z.object({
    name: z.string().min(1).max(100), unit: z.string().max(30),
    values: z.array(z.number().finite().nullable()).min(1).max(366),
  }).strict()).min(1).max(8),
  sources: z.array(z.object({
    kind: z.enum(['user', 'url']), label: z.string().min(1).max(200), url: z.string().max(2000),
  }).strict()).min(1).max(10),
}).strict();

/** A data contract, never model-authored ECharts code or HTML. All keys are required. */
export const numericChartSubmissionSchema = z.object({
  status: z.enum(['ready', 'insufficient-data']), reason: z.string().max(1000),
  title: z.string().max(200), dataset: chartDatasetSchema.nullable(),
}).strict();
export const chartSubmissionSchema = z.union([numericChartSubmissionSchema, weatherSubmissionSchema]);
export type ChartDataset = z.infer<typeof chartDatasetSchema>;
export type ChartSnapshot = {
  title: string;
  dataset: ChartDataset;
  hash: string;
  weather?: {
    locationName: string;
    timezone: string;
    dates: string[];
    weatherCodes: Array<number | null>;
    payload: WeatherSubmission['weather'];
  };
  coverage?: { complete: boolean; missing: string[] };
};
export type ChartFailure = 'insufficient-data' | 'missing-chart' | 'invalid-json' | 'invalid-data' | 'unverified-source' | 'invalid-option' | 'budget-exhausted';

export const chartFailureMessages: Record<ChartFailure, string> = {
  'insufficient-data': '图表未生成：当前数据不足，未补齐或猜测缺失数值。',
  'missing-chart': '图表未生成：模型未返回结构化图表数据，格式修正后仍未符合协议。',
  'invalid-json': '图表未生成：模型返回的数据不是有效 JSON，已停止格式修正。',
  'invalid-data': '图表未生成：数据字段、序列长度或日期范围不符合要求。',
  'unverified-source': '图表未生成：数据来源无法关联到本轮成功取数或用户提供的数据。',
  'invalid-option': '图表未生成：图表配置未通过校验。',
  'budget-exhausted': '图表未生成：已达到本轮执行预算，取数结果已保留。',
};

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function readChartSubmission(text: string, context: { goal: string; sourceUrls: readonly string[]; evidence?: readonly ChartEvidence[]; previousSnapshot?: ChartSnapshot; expectedRange?: string; referenceInstant?: string }):
  { ok: true; snapshot: ChartSnapshot; coverage?: { complete: boolean; missing: string[] } } | { ok: false; reason: ChartFailure; detail?: string } {
  let raw: unknown;
  try { raw = JSON.parse(text.trim()); } catch {
    return { ok: false, reason: text.trimStart().startsWith('{') ? 'invalid-json' : 'missing-chart' };
  }
  if (raw && typeof raw === 'object' && (raw as { schemaVersion?: unknown }).schemaVersion === 2) return readWeatherSubmission(raw, context);
  const parsed = numericChartSubmissionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid-data' };
  const value = parsed.data;
  if (value.status === 'insufficient-data') return { ok: false, reason: 'insufficient-data', detail: value.reason };
  const data = value.dataset;
  if (!data || data.series.some(s => s.values.length !== data.categories.length)) return { ok: false, reason: 'invalid-data' };
  if (new Set(data.categories).size !== data.categories.length || data.series.some(s => s.values.every(v => v === null))) return { ok: false, reason: 'insufficient-data' };
  if (/天气/.test(context.goal) && /七天|7\s*天|一周/.test(context.goal) &&
      (data.categories.length !== 7 || data.series.some(s => s.values.some(v => v === null)))) return { ok: false, reason: 'insufficient-data' };
  const unchanged = context.previousSnapshot && JSON.stringify(data) === JSON.stringify(context.previousSnapshot.dataset);
  if (!unchanged && data.sources.some(s => s.kind === 'user' ? !matchesUserData(data, context.goal) || s.url !== '' :
    !(context.evidence ?? []).some(e => e.url === s.url && matchesStructuredData(data, e.value)))) return { ok: false, reason: 'unverified-source' };
  const owned = structuredClone(data);
  const hash = createHash('sha256').update(JSON.stringify(owned)).digest('hex');
  return { ok: true, snapshot: freeze({ title: value.title || '数据趋势', dataset: owned, hash }) };
}

function readWeatherSubmission(raw: unknown, context: { goal: string; evidence?: readonly ChartEvidence[]; expectedRange?: string; referenceInstant?: string }):
  { ok: true; snapshot: ChartSnapshot; coverage: { complete: boolean; missing: string[] } } | { ok: false; reason: ChartFailure; detail?: string } {
  const parsed = weatherSubmissionSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.dataset || !parsed.data.weather) {
    return parsed.success && parsed.data.status === 'insufficient-data'
      ? { ok: false, reason: 'insufficient-data', detail: parsed.data.reason }
      : { ok: false, reason: 'invalid-data' };
  }
  const assessment = assessWeatherSubmission(parsed.data, context.evidence ?? [], context.goal);
  if (!assessment.valid) return { ok: false, reason: assessment.reason ?? 'invalid-data' };
  const body: WeatherSubmission = parsed.data;
  const dates = body.weather!.dates;
  let expectedRange = context.expectedRange;
  if (context.referenceInstant) {
    const date = new Intl.DateTimeFormat('en-CA', {timeZone:body.weather!.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(context.referenceInstant));
    const start = new Date(`${date}T00:00:00Z`);
    if (/从明天|明天起|明天开始/.test(context.goal)) start.setUTCDate(start.getUTCDate()+1);
    const end = new Date(start); end.setUTCDate(end.getUTCDate()+6);
    expectedRange = `${start.toISOString().slice(0,10)}/${end.toISOString().slice(0,10)}`;
  }
  const expected = expectedRange?.match(/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})/);
  if ((/七天|7\s*天|一周/.test(context.goal) && dates.length !== 7) ||
      (expected && (dates[0] !== expected[1] || dates.at(-1) !== expected[2]))) {
    assessment.missing.push('weather.range'); assessment.complete = false;
  }
  const city = context.goal.match(/(?:给我|查询|展示|一个|一下)?\s*([\u4e00-\u9fff]{2,6}?)(?:往后|未来|接下来|七天|7天)/)?.[1];
  if (city && !body.weather!.location.name.includes(city.replace(/^(给我|给出|查询|展示|生成|一个|看)/, ''))) {
    assessment.missing.push('weather.location'); assessment.complete = false;
  }
  const hash = createHash('sha256').update(JSON.stringify({
    schemaVersion: 2, kind: 'weather', dataset: body.dataset, weather: body.weather,
  })).digest('hex');
  return {
    ok: true,
    snapshot: freeze({
      title: body.title || '天气趋势',
      dataset: body.dataset as ChartDataset,
      hash,
      weather: body.weather ? {
        locationName: body.weather.location.name,
        timezone: body.weather.timezone,
        dates: [...body.weather.dates],
        weatherCodes: [...body.weather.weatherCodes],
        payload: body.weather,
      } : undefined,
      coverage: { complete: assessment.complete, missing: assessment.missing },
    }),
    coverage: { complete: assessment.complete, missing: assessment.missing },
  };
}

export function restoreChartSnapshot(part: any): ChartSnapshot | undefined {
  const value = part?.type === 'data-nero-chart' && part.data?.status === 'ready' ? part.data : undefined;
  if (value?.schemaVersion === 2) {
    const parsed = weatherSubmissionSchema.safeParse(value.submission ?? {schemaVersion:2,kind:'weather',status:'ready',reason:'',title:value.option?.title?.text ?? '天气趋势',dataset:value.dataset,weather:value.weather});
    if (!parsed.success || !parsed.data.dataset || !parsed.data.weather) return;
    const hash = createHash('sha256').update(JSON.stringify({
      schemaVersion: 2, kind: 'weather', dataset: parsed.data.dataset, weather: parsed.data.weather,
    })).digest('hex');
    if (hash !== value.datasetHash) return;
    return freeze({
      coverage: value.coverage,
      title: value.option?.title?.text ?? parsed.data.title ?? '天气趋势',
      dataset: parsed.data.dataset as ChartDataset,
      hash,
      weather: parsed.data.weather ? {
        locationName: parsed.data.weather.location.name,
        timezone: parsed.data.weather.timezone,
        dates: [...parsed.data.weather.dates],
        weatherCodes: [...parsed.data.weather.weatherCodes],
        payload: parsed.data.weather,
      } : undefined,
    });
  }
  const parsed = chartDatasetSchema.safeParse(value?.dataset);
  if (!parsed.success) return;
  const hash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
  if (hash !== value.datasetHash) return;
  return freeze({ title: value.option?.title?.text ?? '数据趋势', dataset: parsed.data, hash });
}

/** Presentation changes cannot change the owned, immutable dataset or its provenance. */
export function buildChart(snapshot: ChartSnapshot, goal: string) {
  const { dataset: data } = snapshot;
  const type = /饼图/.test(goal) ? 'pie' : /柱状图/.test(goal) ? 'bar' : /散点图/.test(goal) ? 'scatter' : 'line';
  const units = [...new Set(data.series.map(s => s.unit))];
  const option = {
    title: { text: snapshot.title }, tooltip: { trigger: type === 'pie' ? 'item' : 'axis' },
    legend: { top: 32 }, grid: { top: 80, bottom: 40, containLabel: true },
    ...(type === 'pie' ? {} : {
      xAxis: { type: 'category', data: [...data.categories] },
      yAxis: units.map((unit, i) => ({ type: 'value', name: unit, position: i % 2 ? 'right' : 'left', offset: Math.floor(i / 2) * 50 })),
    }),
    series: data.series.map((s, i) => ({ name: s.name, type,
      ...(type === 'pie' ? { radius: ['30%', '65%'], center: [`${(i + 0.5) * 100 / data.series.length}%`, '60%'] } : { yAxisIndex: units.indexOf(s.unit) }),
      data: type === 'pie' ? s.values.map((value, j) => ({ name: data.categories[j], value })) : [...s.values],
    })),
  };
  const sources = data.sources.map(s => s.kind === 'user' ? '用户提供的数据' : s.url);
  const markdown = `\`\`\`echarts\n${JSON.stringify(option)}\n\`\`\`\n\n数据范围：${data.categories[0]} — ${data.categories.at(-1)}。来源：${sources.join('；')}。`;
  return { option, markdown };
}
