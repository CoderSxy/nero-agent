import type { FinanceInterface } from './catalog';

const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
let active = 0;

export function aktoolsBaseUrl(): URL {
  const raw = process.env.AKTOOLS_BASE_URL;
  if (!raw) throw new Error('AKTools 服务未配置');
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('AKTools 地址必须是本机 HTTP 服务根地址');
  }
  return url;
}

function rowTime(row: Record<string, unknown>): string | null {
  const fields = ['日期', '净值日期', '月份', '季度', 'date', '时间'];
  return fields.map(field => row[field]).find(value => typeof value === 'string') as string | undefined ?? null;
}

function dataTimeOf(rows: Record<string, unknown>[]): string | null {
  const values = rows.map(rowTime).filter((value): value is string => Boolean(value));
  return values.sort().at(-1) ?? null;
}

export async function fetchFinanceData(item: FinanceInterface, params: Record<string, string>,
  fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  if (active >= 2) throw new Error('财经数据服务繁忙，请稍后重试');
  const url = new URL(`api/public/${item.name}`, aktoolsBaseUrl());
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  active += 1;
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`AKTools 返回 HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('AKTools 响应不是 JSON');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('AKTools 响应为空');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('AKTools 响应超过大小限制'); }
      chunks.push(value);
    }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('AKTools 返回了无效 JSON'); }
    if (!Array.isArray(payload) || payload.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('AKTools 返回的数据格式与接口目录不符');
    }
    const allRows = payload as Record<string, unknown>[];
    const dated = allRows.some(row => rowTime(row));
    const rows = (dated ? [...allRows].sort((a, b) => (rowTime(a) ?? '').localeCompare(rowTime(b) ?? ''))
      : allRows).slice(-item.maxRows);
    return { status: allRows.length ? 'ok' : 'empty', interface: item.name, parameters: params,
      source: item.source, dataTime: dataTimeOf(allRows), fetchedAt: new Date().toISOString(),
      units: item.units, totalRows: allRows.length, truncated: allRows.length > rows.length,
      rows, catalogVersion: '2026-10-13' };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('AKTools 请求超时');
    throw error;
  } finally { clearTimeout(timer); active -= 1; }
}
