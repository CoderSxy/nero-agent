import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import type { AuthUser } from '../src/mastra/auth/service';
import { createHistoryRoutes } from '../src/mastra/history/routes';
import type { HistoryRepository } from '../src/mastra/history/repository';
import { loadHistoryWindow } from '../src/mastra/history/service';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THREAD_A = 'thread-memory-boundary';
const MASTRA_USER_KEY = 'mastra__user';

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

function buildApp(routes: ApiRoute[]) {
  const app = new Hono();
  for (const route of routes) {
    if (!('handler' in route) || !route.handler) throw new Error(`route ${route.path} has no handler`);
    const handler = route.handler;
    app.on(route.method, route.path, async (c, next) => {
      const requestContext = new RequestContext();
      c.set('requestContext', requestContext);
      const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? '';
      if (token === 'a') requestContext.set(MASTRA_USER_KEY, user(USER_A));
      else return c.json({ error: 'Unauthorized' }, 401);
      return handler(c, next);
    });
  }
  return app;
}

test('history window API is read-only and does not touch memory writes', async () => {
  const writes: string[] = [];
  const memory = {
    saveMessages: async () => {
      writes.push('saveMessages');
      return { messages: [] };
    },
    updateThread: async () => {
      writes.push('updateThread');
    },
    getThreadById: async () => ({ id: THREAD_A, resourceId: USER_A }),
  };

  const repo: HistoryRepository = {
    async withReadTransaction(fn) {
      return fn({} as never);
    },
    async getThread() {
      return { id: THREAD_A, resourceId: USER_A, updatedAt: '2026-10-01T00:00:00.000Z' };
    },
    async getUpper() {
      return { id: 'm2', createdAt: '2026-10-01 00:00:02' };
    },
    async readMetadata() {
      return [
        { id: 'm1', role: 'user', createdAt: '2026-10-01 00:00:01', contentBytes: 4 },
        { id: 'm2', role: 'assistant', createdAt: '2026-10-01 00:00:02', contentBytes: 4 },
      ];
    },
    async readMessages(_scope, ids) {
      return ids.map((id) => ({
        id,
        role: id === 'm1' ? 'user' : 'assistant',
        createdAt: id === 'm1' ? '2026-10-01 00:00:01' : '2026-10-01 00:00:02',
        threadId: THREAD_A,
        resourceId: USER_A,
        content: { format: 2, parts: [{ type: 'text', text: id }] },
      }));
    },
    async findTarget() {
      return null;
    },
    async findTurnContext() {
      return null;
    },
  };

  const app = buildApp(
    createHistoryRoutes({
      lookup: memory,
      repositoryFactory: () => repo,
    }),
  );

  const response = await app.request(`/agent-history/threads/${THREAD_A}/window`, {
    headers: { authorization: 'Bearer a' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(writes, []);

  // Simulate chat send binding: UI window may be truncated, but send still uses original thread/resource.
  const window = await loadHistoryWindow(repo, { userId: USER_A, threadId: THREAD_A }, {});
  const sendBinding = {
    threadId: THREAD_A,
    resourceId: USER_A,
    uiMessageCount: window.messages.length,
  };
  assert.equal(sendBinding.threadId, THREAD_A);
  assert.equal(sendBinding.resourceId, USER_A);

  // Server-side memory history remains independently addressable (full thread ids still exist in repo metadata).
  const fullMeta = await repo.readMetadata(
    { userId: USER_A, threadId: THREAD_A },
    { upper: { id: 'm2', createdAt: '2026-10-01 00:00:02' }, limit: 100 },
  );
  assert.ok(fullMeta.length >= window.messages.length);
  assert.deepEqual(writes, []);
});

test('signal fallback send binding still uses owned thread/resource ids', () => {
  const signalFallback = {
    role: 'signal' as const,
    type: 'user',
    content: { format: 2 as const, metadata: { signal: { type: 'user' } }, parts: [{ type: 'text', text: '继续' }] },
  };
  const binding = {
    threadId: THREAD_A,
    resourceId: USER_A,
    message: signalFallback,
  };
  assert.equal(binding.threadId, THREAD_A);
  assert.equal(binding.resourceId, USER_A);
  assert.equal(binding.message.content.metadata.signal.type, 'user');
});
