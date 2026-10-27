import assert from 'node:assert/strict';
import test from 'node:test';

test('startup probe requires JSON auth response, rejects HTML and bounds startup time', async () => {
  const { waitForReady } = await import('../scripts/ops/wait-ready.mjs');
  await waitForReady({ timeoutMs: 50, intervalMs: 1,
    fetcher: async () => new Response('{"error":"Unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } }) });
  for (const response of [
    () => new Response('<html>index</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => new Response('broken', { status: 401, headers: { 'content-type': 'application/json' } }),
  ]) await assert.rejects(waitForReady({ timeoutMs: 20, intervalMs: 1,
    fetcher: async () => response() }), /ready|就绪/);
});
