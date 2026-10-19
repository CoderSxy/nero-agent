import type { EChartsOption } from 'echarts';
import JSON5 from 'json5';

const MAX_OPTION_LENGTH = 100_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
export type EChartsParseResult =
  | { ok: true; option: EChartsOption; format: 'json' | 'json5' }
  | { ok: false; kind: 'limit' | 'syntax' | 'structure'; message: string };

/** Normalize only quoted string contents, respecting JSON5 comments and escapes. */
function normalizeOptionText(code: string): string {
  let text = code.trim();
  if (text.startsWith('(') && text.endsWith(')')) {
    const inner = text.slice(1, -1).trim();
    if (inner.startsWith('{') && inner.endsWith('}')) text = inner;
  }
  let result = '';
  let quote = '';
  let comment: 'line' | 'block' | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (comment) {
      result += char;
      if (comment === 'line' && (char === '\n' || char === '\r')) comment = undefined;
      else if (comment === 'block' && char === '*' && next === '/') {
        result += next; i++; comment = undefined;
      }
    } else if (quote) {
      if (char === '\\') {
        result += char;
        if (next !== undefined) {
          result += next; i++;
          if (next === '\r' && text[i + 1] === '\n') { result += '\n'; i++; }
        }
      } else if (char === quote) { result += char; quote = ''; }
      else if (char === '\n') result += '\\n';
      else if (char === '\r') result += '\\r';
      else result += char;
    } else {
      result += char;
      if (char === '"' || char === "'") quote = char;
      else if (char === '/' && (next === '/' || next === '*')) {
        comment = next === '/' ? 'line' : 'block'; result += next; i++;
      }
    }
  }
  return result;
}

function validateOption(value: unknown): EChartsParseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, kind: 'structure', message: '图表配置必须是一个 option 对象。' };
  }
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'number' && !Number.isFinite(current)) {
      return { ok: false, kind: 'structure', message: '图表配置不能包含 NaN、Infinity 或溢出的数值。' };
    }
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (FORBIDDEN_KEYS.has(key)) {
          return { ok: false, kind: 'structure', message: `图表配置包含不支持的键：${key}。` };
        }
        pending.push(child);
      }
    }
  }
  return { ok: true, option: value as EChartsOption, format: 'json' };
}

export function parseEChartsResult(code: string): EChartsParseResult {
  const tooLong: EChartsParseResult = { ok: false, kind: 'limit', message: '图表配置过长，暂无法展示。' };
  if (code.length > MAX_OPTION_LENGTH) return tooLong;
  let value: unknown;
  let format: 'json' | 'json5' = 'json';
  try { value = JSON.parse(code); }
  catch {
    const normalized = normalizeOptionText(code);
    if (normalized.length > MAX_OPTION_LENGTH) return tooLong;
    try { value = JSON5.parse(normalized); format = 'json5'; }
    catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 240) : '';
      return { ok: false, kind: 'syntax', message:
        `图表配置格式不正确；请使用 JSON/JSON5 数据，不支持函数、变量或表达式。${detail ? ` ${detail}` : ''}` };
    }
  }
  const result = validateOption(value);
  return result.ok ? { ...result, format } : result;
}

export function parseEChartsOption(code: string): EChartsOption | null {
  const result = parseEChartsResult(code);
  return result.ok ? result.option : null;
}

/** Only promote recognizable chart data in otherwise general-purpose JSON fences. */
export function isEChartsCode(code: string): boolean {
  const option = parseEChartsOption(code);
  const series = Array.isArray(option?.series) ? option.series : [option?.series];
  return series.some(item => item !== null && typeof item === 'object' && typeof item.type === 'string');
}
