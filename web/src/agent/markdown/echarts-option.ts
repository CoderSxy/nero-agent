import type { EChartsOption } from 'echarts';

export function parseEChartsOption(code: string): EChartsOption | null {
  if (code.length > 100_000) return null;
  try {
    const value: unknown = JSON.parse(code);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (JSON.stringify(value).match(/"(?:__proto__|prototype|constructor)"\s*:/)) return null;
    return value as EChartsOption;
  } catch {
    return null;
  }
}

/** JSON fences are used for many things; only promote a recognizable chart option. */
export function isEChartsCode(code: string): boolean {
  const option = parseEChartsOption(code);
  return Array.isArray(option?.series) && option.series.some(series =>
    series !== null && typeof series === 'object' && typeof series.type === 'string');
}
