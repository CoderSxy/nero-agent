/** Open-Meteo WMO codes copied from https://open-meteo.com/en/docs on 2026-10-22. */
export const WEATHER_CODE_SOURCE = 'https://open-meteo.com/en/docs';
export const WEATHER_CODE_MAP_VERSION = 'open-meteo-docs-2026-10-22';

const CODES: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '局部多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '中毛毛雨',
  55: '浓毛毛雨',
  56: '小冻毛毛雨',
  57: '浓冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '小冻雨',
  67: '大冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '中阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  97: '强雷暴',
  99: '雷暴伴大冰雹',
};

export function weatherCodeLabel(code: number | null): string | null {
  if (code === null || !Number.isInteger(code)) return null;
  return CODES[code] ?? null;
}
