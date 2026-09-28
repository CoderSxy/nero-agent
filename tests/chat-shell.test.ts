import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mastraProxyTarget } from '../web/src/dev-proxy.ts';
import {
  formatThreadTime,
  sortThreads,
  threadSubtitle,
  threadTitle,
} from '../web/src/lib/thread-label.ts';
import { readSse } from '../web/src/lib/sse.ts';
import { emptyTurn, reduceChunk } from '../web/src/lib/stream-reducer.ts';
import { historyFromMessages } from '../web/src/lib/messages.ts';

test('dev script starts mastra and the web shell together', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.match(pkg.scripts.dev, /concurrently/);
  assert.match(pkg.scripts.dev, /mastra dev/);
  assert.match(pkg.scripts.dev, /--prefix web/);
  assert.ok(pkg.devDependencies.concurrently);
  assert.equal(mastraProxyTarget, 'http://127.0.0.1:4111');
});

test('thread labels use custom title, then stored title, then a fallback', () => {
  const renamed = {
    id: 'a',
    title: '原始提问',
    createdAt: '2026-09-28T03:12:38.000Z',
    updatedAt: '2026-09-28T04:00:00.000Z',
    metadata: { customTitle: '改过的名字' },
  };
  assert.equal(threadTitle(renamed), '改过的名字');
  assert.equal(threadTitle({ ...renamed, metadata: {} }), '原始提问');
  assert.equal(threadTitle({ id: 'b', createdAt: renamed.createdAt, updatedAt: renamed.updatedAt }), '新对话');
});

test('subtitle prefers updatedAt and does not zero-pad month or day', () => {
  const thread = {
    id: 'a',
    createdAt: '2026-01-02T01:02:03.000Z',
    updatedAt: '2026-09-28T03:12:38.000Z',
  };
  const text = threadSubtitle(thread);
  const expected = formatThreadTime(thread.updatedAt);
  assert.equal(text, expected);
  const local = new Date(thread.updatedAt);
  assert.match(text, new RegExp(`${local.getFullYear()}年${local.getMonth() + 1}月${local.getDate()}日 `));
  assert.doesNotMatch(text, /年09月/);
});

test('sortThreads orders by updatedAt descending', () => {
  const sorted = sortThreads([
    { id: 'old', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ['new', 'old']);
});

test('readSse emits each data payload', async () => {
  const encoded = new TextEncoder().encode('data: {"type":"text-delta"}\n\ndata: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  const events: string[] = [];
  await readSse(stream, (data) => events.push(data));
  assert.deepEqual(events, ['{"type":"text-delta"}', '[DONE]']);
});

test('readSse flushes a final frame that is not terminated', async () => {
  const encoded = new TextEncoder().encode('data: {"ok":true}');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  const events: string[] = [];
  await readSse(stream, (data) => events.push(data));
  assert.deepEqual(events, ['{"ok":true}']);
});

test('reduceChunk accumulates text, reasoning, tools, approval, and errors', () => {
  let turn = emptyTurn();
  turn = reduceChunk(turn, { type: 'text-delta', runId: 'run-1', payload: { text: '你好' } });
  turn = reduceChunk(turn, { type: 'text-delta', payload: { text: '。' } });
  turn = reduceChunk(turn, { type: 'reasoning-delta', payload: { text: '先查一下' } });
  turn = reduceChunk(turn, { type: 'tool-call', payload: { toolCallId: 'c1', toolName: 'web_search', args: { q: '天气' } } });
  turn = reduceChunk(turn, { type: 'tool-call-approval', payload: { toolCallId: 'c1', toolName: 'web_search', args: { q: '天气' } } });
  turn = reduceChunk(turn, { type: 'tool-result', payload: { toolCallId: 'c1', toolName: 'web_search', result: { ok: true } } });
  turn = reduceChunk(turn, { type: 'error', payload: { message: '中断' } });
  assert.equal(turn.text, '你好。');
  assert.equal(turn.reasoning, '先查一下');
  assert.equal(turn.runId, 'run-1');
  assert.equal(turn.tools[0]?.approval, 'approved');
  assert.deepEqual(turn.tools[0]?.result, { ok: true });
  assert.equal(turn.error, '中断');
});

test('tool-result does not invent an approval', () => {
  const turn = reduceChunk(emptyTurn(), {
    type: 'tool-result',
    payload: { toolCallId: 'c2', toolName: 'web_fetch', result: 'ok' },
  });
  assert.equal(turn.tools[0]?.approval, 'none');
});

import { createMastraClient } from '../web/src/lib/mastra-client.ts';

test('client creates a thread and consumes an SSE text delta', async () => {
  let createdBody: { resourceId?: string; title?: string } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/api/memory/threads?') && init?.method === 'POST') {
      createdBody = JSON.parse(String(init?.body)) as { resourceId?: string; title?: string };
      assert.match(url, /agentId=agent/);
      return new Response(JSON.stringify({
        id: 't1',
        title: '帮我看天气',
        resourceId: 'local-user',
        createdAt: '2026-09-28T03:12:38.000Z',
        updatedAt: '2026-09-28T03:12:38.000Z',
      }), { status: 200 });
    }
    if (url.endsWith('/api/agents/agent/stream')) {
      const body = new TextEncoder().encode('data: {"type":"text-delta","runId":"r1","payload":{"text":"你好"}}\n\n');
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }), { status: 200 });
    }
    return new Response('nope', { status: 500 });
  };
  const client = createMastraClient(fetchImpl);
  const thread = await client.createThread('帮我看天气');
  assert.equal(thread.id, 't1');
  assert.equal(createdBody?.resourceId, 'local-user');
  assert.equal(createdBody?.title, '帮我看天气');
  const turns: string[] = [];
  await client.streamMessage('t1', '帮我看天气', (turn) => turns.push(turn.text));
  assert.equal(turns.at(-1), '你好');
});

test('client throws when thread list is not ok', async () => {
  const client = createMastraClient(async () => new Response('down', { status: 503 }));
  await assert.rejects(() => client.listThreads(), /503/);
});

test('historyFromMessages keeps user and assistant text parts', () => {
  const history = historyFromMessages([
    { id: '1', role: 'user', content: '帮我看天气' },
    { id: '2', role: 'assistant', content: [{ type: 'text', text: '今天晴' }] },
    { id: '3', role: 'system', content: '忽略' },
    { role: 'user', parts: [{ type: 'text', text: '' }] },
  ]);
  assert.deepEqual(history, [
    { id: '1', role: 'user', text: '帮我看天气' },
    { id: '2', role: 'assistant', text: '今天晴' },
  ]);
});
