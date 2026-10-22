import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildChart, readChartSubmission, restoreChartSnapshot } from '../src/mastra/agents/chart-data';
import { resolveTurnPolicy } from '../src/mastra/agents/turn-policy';
import { buildWeatherChart, type WeatherChartSnapshot } from '../src/mastra/agents/weather/render';

const snapshot: WeatherChartSnapshot = {
  title: '上海市浦东新区未来七天天气趋势',
  hash: 'weather-hash',
  locationName: '上海市浦东新区张江科学城气象站',
  timezone: 'Asia/Shanghai',
  dates: ['2026-10-22', '2026-10-23'],
  weatherCodes: [1, 123],
  series: [
    { metric: 'temperature-max', name: '最高温', unit: '°C', values: [22, 20] },
    { metric: 'temperature-min', name: '最低温', unit: '°C', values: [16, 15] },
    { metric: 'precipitation-probability', name: '降水概率', unit: '%', values: [10, null] },
    { metric: 'humidity-mean', name: '日均相对湿度', unit: '%', values: [70, 65] },
  ],
};

function walk(value: unknown, seen: unknown[] = []): void {
  if (!value || typeof value !== 'object') {
    assert.notEqual(typeof value, 'function');
    return;
  }
  if (seen.includes(value)) return;
  seen.push(value);
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(typeof child, 'function', key);
    if (typeof child === 'string') {
      assert.doesNotMatch(child, /<[^>]+>/);
      assert.doesNotMatch(child, /^https?:/i);
    }
    walk(child, seen);
  }
}

test('weather charts show daily text, separate units, and missing data without remote markup', () => {
  const built = buildWeatherChart(snapshot, { complete: false, missing: ['weather.precipitation'] });
  assert.match(built.summary, /2026-10-22/);
  assert.match(built.summary, /大部晴朗/);
  assert.match(built.summary, /未知天气（代码 123）/);
  assert.match(built.summary, /°C/);
  assert.match(built.summary, /%/);
  assert.match(built.summary, /日均相对湿度/);
  assert.match(built.summary, /70/);
  assert.match(built.summary, /缺项/);
  const option = built.option as { grid: unknown[]; series: Array<{ yAxisIndex?: number }>; legend: { bottom?: number }; title: { text: string } };
  assert.ok(option.grid.length >= 2);
  assert.notEqual(option.series[0]?.yAxisIndex, option.series.at(-1)?.yAxisIndex);
  assert.equal(option.legend.bottom, 0);
  assert.match(option.title.text, /张江科学城/);
  walk(built.option);
  assert.equal(JSON.stringify(built.option).includes('function'), false);
  const narrow = buildWeatherChart(snapshot, { complete: false, missing: ['weather.precipitation'] }, { width: 360 });
  assert.equal((narrow.option as { media?: unknown[] }).media?.length, 1);
});

test('v1 charts keep their hash and weather styling does not refetch or rewrite data', () => {
  const dataset = { categories: ['一月', '二月'], series: [{ name: '销售额', unit: '元', values: [10, 20] }], sources: [{ kind: 'user' as const, label: '用户', url: '' }] };
  const text = JSON.stringify({ status: 'ready', reason: '', title: '销售', dataset });
  const owned = readChartSubmission(text, { goal: '一月10，二月20 销售额', sourceUrls: [] });
  assert.ok(owned.ok);
  const v1Hash = createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
  assert.equal(owned.snapshot.hash, v1Hash);
  assert.equal(buildChart(owned.snapshot, '改成红色').markdown.includes('一月'), true);
  assert.equal(owned.snapshot.hash, v1Hash);
  const restored = restoreChartSnapshot({ type: 'data-nero-chart', data: { status: 'ready', dataset, datasetHash: v1Hash, option: { title: { text: '销售' } } } });
  assert.equal(restored?.hash, v1Hash);
  const styled = buildWeatherChart(snapshot, { complete: true, missing: [] });
  const again = buildWeatherChart({ ...snapshot, title: '换成红色' }, { complete: true, missing: [] });
  assert.equal(styled.summary.includes('2026-10-22'), again.summary.includes('2026-10-22'));
  assert.equal(snapshot.hash, 'weather-hash');
  assert.equal(resolveTurnPolicy({ userText: '把说明做成 HTML 网页' }).deliveryMode, 'html-artifact');
  assert.equal(resolveTurnPolicy({ userText: '根据附件画图', hasAttachments: true }).deliveryMode, 'mixed');
});
