import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export async function waitForReady({ timeoutMs = 80_000, intervalMs = 1000,
  url = `http://127.0.0.1:${process.env.PORT || process.env.MASTRA_PORT || '4111'}/auth/me`, fetcher = fetch } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 80_000) throw new Error('Invalid readiness timeout');
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:' || target.pathname !== '/auth/me') throw new Error('Probe must use local backend /auth/me');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetcher(target, { redirect: 'error', signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))) });
      const contentType = response.headers.get('content-type') || '';
      if (response.status === 401 && contentType.includes('application/json')) {
        const body = await response.json();
        if (body && typeof body === 'object' && !Array.isArray(body)) return;
      } else await response.body?.cancel();
    } catch { /* Server not listening yet, or malformed auth response. Retry only until deadline. */ }
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error('Backend not ready before startup deadline');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await waitForReady(); console.log('Backend auth JSON probe ready'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
