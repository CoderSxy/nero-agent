import { weatherCodeLabel } from './codes';

export type WeatherChartSeries = {
  metric: string;
  name: string;
  unit: string;
  values: Array<number | null>;
};

export type WeatherChartSnapshot = {
  title: string;
  hash: string;
  locationName: string;
  timezone: string;
  dates: string[];
  weatherCodes: Array<number | null>;
  series: WeatherChartSeries[];
};

export type WeatherChartCoverage = { complete: boolean; missing: string[] };

function conditionText(code: number | null): string {
  if (code === null) return '天气缺测';
  return weatherCodeLabel(code) ?? `未知天气（代码 ${code}）`;
}

function numberText(value: number | null, unit: string): string {
  return value === null ? '缺' : `${value}${unit}`;
}

export function buildWeatherChart(
  snapshot: WeatherChartSnapshot,
  coverage: WeatherChartCoverage,
  layout: { width?: number } = {},
): { option: Record<string, unknown>; markdown: string; summary: string } {
  const groups = [
    { metrics: ['temperature-max', 'temperature-min'], axis: '°C' },
    { metrics: ['precipitation-probability', 'precipitation-amount'], axis: '降水' },
    { metrics: ['humidity-mean'], axis: '%' },
    { metrics: ['wind-speed-max'], axis: '风速' },
  ].map(group => ({
    ...group,
    series: snapshot.series.filter(series => group.metrics.includes(series.metric)),
  })).filter(group => group.series.length > 0);
  const grids = groups.map((_group, index) => ({
    left: layout.width && layout.width <= 360 ? 8 : 48,
    right: 16,
    top: 72 + index * 150,
    height: 100,
    containLabel: true,
  }));
  const option: Record<string, unknown> = {
    title: { text: snapshot.locationName, left: 0, top: 0, textStyle: { width: 220, overflow: 'truncate' } },
    legend: { bottom: 0, type: 'scroll' },
    tooltip: { trigger: 'axis' },
    grid: grids,
    xAxis: groups.map((_group, index) => ({ type: 'category', gridIndex: index, data: [...snapshot.dates] })),
    yAxis: groups.map((group, index) => ({ type: 'value', gridIndex: index, name: group.series[0]?.unit || group.axis })),
    series: groups.flatMap((group, index) => group.series.map(series => ({
      name: series.name,
      type: series.metric.startsWith('temperature') ? 'line' : 'bar',
      xAxisIndex: index,
      yAxisIndex: index,
      data: [...series.values],
    }))),
    media: [{
      query: { maxWidth: 360 },
      option: { legend: { bottom: 0, type: 'scroll' }, grid: grids.map(grid => ({ ...grid, left: 8, right: 8 })) },
    }],
  };
  const lines = snapshot.dates.map((date, index) => {
    const metrics = snapshot.series.map(series => `${series.name} ${numberText(series.values[index] ?? null, series.unit)}`).join(' ');
    return `${date} ${conditionText(snapshot.weatherCodes[index] ?? null)} ${metrics}`;
  });
  const missing = coverage.missing.length ? `缺项：${coverage.missing.join('、')}` : '';
  const summary = [missing, `${snapshot.locationName}（${snapshot.timezone}）`, ...lines].filter(Boolean).join('\n');
  const markdown = `\`\`\`echarts\n${JSON.stringify(option)}\n\`\`\`\n\n${summary}`;
  return { option, markdown, summary };
}
