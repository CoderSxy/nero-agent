import assert from 'node:assert/strict';
import test from 'node:test';
import { studioChineseMiddleware } from '../src/mastra/studio-zh';

test('Studio middleware injects the Chinese UI only into HTML responses', async () => {
  const htmlContext = {
    req: { path: '/agents' },
    res: new Response('<html><head></head><body></body></html>', {
      headers: { 'content-type': 'text/html' },
    }),
  };
  await studioChineseMiddleware.handler(htmlContext, async () => {});
  const html = await htmlContext.res.text();
  assert.match(html, /智能体平台|\\u667A\\u80FD\\u4F53\\u5E73\\u53F0/);
  assert.match(html, /\/workflows/);

  const apiContext = {
    req: { path: '/api/agents' },
    res: new Response('{"agents":[]}', { headers: { 'content-type': 'application/json' } }),
  };
  await studioChineseMiddleware.handler(apiContext, async () => {});
  assert.equal(await apiContext.res.text(), '{"agents":[]}');
});
