import type { ChartDataset } from './chart-data';

export type ChartEvidence = { url: string; value: unknown };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const numbers = (text: string) => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
function key(name: string) {
  if (/最高|最大|temperature_2m_max|^highs?$|^max$/i.test(name)) return 'high';
  if (/最低|最小|temperature_2m_min|^lows?$|^min$/i.test(name)) return 'low';
  return name.replace(/[\s_℃°]+/g, '').toLowerCase();
}
function dateLabel(value: string) { return value.replace(/^\d{4}-/, '').replace(/-/g, '/').split(/\s/)[0]; }
function sameCategories(a: string[], b: string[]) { return equal(a.map(dateLabel), b.map(dateLabel)); }

/** Conservative checks: an unstructured page is evidence to read, not a trusted numeric array. */
export function matchesStructuredData(data: ChartDataset, value: unknown): boolean {
  function visit(node: unknown, depth = 0): boolean {
    if (depth > 12) return false;
    if (typeof node === 'string' && node.length < 100000) {
      try { return visit(JSON.parse(node), depth + 1); } catch { return false; }
    }
    if (Array.isArray(node)) return node.some(child => visit(child, depth + 1));
    if (!node || typeof node !== 'object') return false;
    const record = node as Record<string, unknown>;
    // Bind axes and numeric arrays within the same record, never across siblings.
    const arrays = Object.entries(record).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([name, values]) => ({name, values}));
    for (const series of Array.isArray(record.series) ? record.series : []) {
      if (series && typeof series.name === 'string' && Array.isArray(series.values)) arrays.push({name:series.name,values:series.values});
    }
    if (arrays.some(a => a.values.every(v => typeof v === 'string') && sameCategories(data.categories, a.values as string[])) &&
        data.series.every(s => arrays.some(a => equal(a.values, s.values) && (data.series.length === 1 || key(a.name) === key(s.name))))) return true;
    return Object.values(record).some(child => visit(child, depth + 1));
  }
  return visit(value);
}

export function matchesUserData(data: ChartDataset, goal: string): boolean {
  const positions = data.categories.map(c => goal.indexOf(c));
  // Named category/value pairs, e.g. 一月10，二月20 (also rejects reordered data).
  if (data.series.length === 1 && positions.every((p, i) => p >= 0 && (!i || p > positions[i - 1]))) {
    return data.series[0].values.every((v, i) => numbers(goal.slice(positions[i] + data.categories[i].length, positions[i + 1] ?? goal.length))[0] === v);
  }
  // Named arrays, e.g. 最高温19,22,... 最低温12,17,... with an explicit date range.
  const dates = data.categories.map(dateLabel);
  const endpointsPresent = goal.includes(dates[0]) && goal.includes(dates.at(-1)!);
  const explicitCategories = positions.every((p, i) => p >= 0 && (!i || p > positions[i - 1]));
  if (!explicitCategories) {
    if (!endpointsPresent || !dates.every(d => /^\d{2}\/\d{2}$/.test(d))) return false;
    const year = data.categories[0].match(/^(\d{4})-/)?.[1] ?? '2000';
    const start = new Date(`${year}-${dates[0].replace('/', '-')}T00:00:00Z`).getTime();
    if (!Number.isFinite(start) || !dates.every((d, i) => new Date(start + i * 86400000).toISOString().slice(5, 10).replace('-', '/') === d)) return false;
  }
  return data.series.every(s => {
    const name = key(s.name);
    const marker = name === 'high' ? /最高(?:气温|温度|温)?[\s:：]*/ : name === 'low' ? /最低(?:气温|温度|温)?[\s:：]*/ : null;
    const match = marker?.exec(goal);
    if (!match) return false;
    const tail = goal.slice(match.index + match[0].length).match(/^-?\d+(?:\.\d+)?(?:[\s,，、]+-?\d+(?:\.\d+)?)*\s*/)?.[0];
    return !!tail && equal(numbers(tail), s.values);
  });
}

/** Only URLs attached to successful result records count; query/args never do. */
export function collectChartEvidence(result: unknown): ChartEvidence[] {
  const value = result as any;
  if (!value || value.isError || value.ok === false) return [];
  const records = Array.isArray(value.results) ? value.results : [value];
  return records.flatMap((record: any) => {
    const raw = record?.url ?? record?.finalUrl;
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
      return [{ url: url.href, value: structuredClone(record) }];
    } catch { return []; }
  });
}
