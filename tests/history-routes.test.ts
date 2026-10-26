import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import type { AuthUser } from '../src/mastra/auth/service';
import { createHistoryRoutes } from '../src/mastra/history/routes';
import type { HistoryRepository } from '../src/mastra/history/repository';
import { encodeHistoryCursor } from '../src/mastra/history/cursor';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THREAD_A = 'thread-history-a';
const THREAD_B = 'thread-history-b';
const MASTRA_USER_KEY = 'mastra__user';

function user(id: string, roles: AuthUser['roles'] = ['user']): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles };
}

function lookup() {
  const threads = [
    { id: THREAD_A, resourceId: USER_A },
    { id: THREAD_B, resourceId: USER_B },
  ];
  return {
    getThreadById: async ({ threadId }: { threadId: string }) =>
      threads.find((thread) => thread.id === threadId) ?? null,
  };
}

function buildApp(routes: ApiRoute[]) {
  const app = new Hono();
  for (const route of routes) {
    if (!('handler' in route) || !route.handler) throw new Error(`route ${route.path} has no handler`);
    const handler = route.handler;
    app.on(route.method, route.path, async (c, next) => {
      const requestContext = new RequestContext();
      c.set('requestContext', requestContext);
      if (route.requiresAuth !== false) {
        const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? '';
        if (token === 'a') requestContext.set(MASTRA_USER_KEY, user(USER_A));
        else if (token === 'b') requestContext.set(MASTRA_USER_KEY, user(USER_B));
        else if (token === 'admin') requestContext.set(MASTRA_USER_KEY, user(USER_A, ['admin', 'user']));
        else return c.json({ error: 'Unauthorized' }, 401);
      }
      return handler(c, next);
    });
  }
  return app;
}

function fakeRepo(overrides: Partial<HistoryRepository> = {}): HistoryRepository {
  const upper = { id: 'm2', createdAt: '2026-10-01 00:00:02' };
  const base: HistoryRepository = {
    async withReadTransaction(fn) {
      return fn({} as never);
    },
    async getThread(scope) {
      if (scope.threadId !== THREAD_A || scope.userId !== USER_A) return null;
      return { id: THREAD_A, resourceId: USER_A, updatedAt: '2026-10-01T00:00:02.000Z' };
    },
    async getUpper(scope) {
      if (scope.threadId !== THREAD_A) return null;
      return upper;
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
    async findTarget(_scope, messageId) {
      if (messageId === 'm1' || messageId === 'm2') {
        return {
          id: messageId,
          createdAt: messageId === 'm1' ? '2026-10-01 00:00:01' : '2026-10-01 00:00:02',
          threadId: THREAD_A,
          resourceId: USER_A,
        };
      }
      if (messageId === 'foreign') {
        return null;
      }
      return null;
    },
    async findTurnContext() {
      return null;
    },
    ...overrides,
  };
  return base;
}

test('history window routes enforce auth, ownership, and query rules', async () => {
  const app = buildApp(
    createHistoryRoutes({
      lookup: lookup(),
      repositoryFactory: () => fakeRepo(),
    }),
  );

  assert.equal((await app.request(`/agent-history/threads/${THREAD_A}/window`)).status, 401);

  const denied = await app.request(`/agent-history/threads/${THREAD_A}/window`, {
    headers: { authorization: 'Bearer b' },
  });
  assert.equal(denied.status, 403);

  const adminDenied = await app.request(`/agent-history/threads/${THREAD_B}/window`, {
    headers: { authorization: 'Bearer admin' },
  });
  assert.equal(adminDenied.status, 403);

  const missing = await app.request(`/agent-history/threads/missing/window`, {
    headers: { authorization: 'Bearer a' },
  });
  assert.equal(missing.status, 404);

  const ok = await app.request(`/agent-history/threads/${THREAD_A}/window?userId=${USER_B}&resourceId=${USER_B}`, {
    headers: { authorization: 'Bearer a' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const body = await ok.json();
  assert.equal(body.thread.resourceId, USER_A);
  assert.equal(body.version, 1);

  const foreignTarget = await app.request(`/agent-history/threads/${THREAD_A}/window?around=foreign`, {
    headers: { authorization: 'Bearer a' },
  });
  assert.equal(foreignTarget.status, 404);

  const mutex = await app.request(
    `/agent-history/threads/${THREAD_A}/window?before=abc&after=def`,
    { headers: { authorization: 'Bearer a' } },
  );
  assert.equal(mutex.status, 400);

  const badCursor = encodeHistoryCursor({
    version: 1,
    userId: USER_B,
    threadId: THREAD_B,
    direction: 'before',
    boundary: { id: 'x', createdAt: '2026-10-01 00:00:00' },
    snapshotUpper: { id: 'x', createdAt: '2026-10-01 00:00:00' },
  });
  const scopeMismatch = await app.request(
    `/agent-history/threads/${THREAD_A}/window?before=${encodeURIComponent(badCursor)}`,
    { headers: { authorization: 'Bearer a' } },
  );
  assert.equal(scopeMismatch.status, 400);

  const boom = buildApp(
    createHistoryRoutes({
      lookup: lookup(),
      repositoryFactory: () =>
        fakeRepo({
          async withReadTransaction() {
            throw new Error('SELECT * FROM secret_table WHERE password=1');
          },
        }),
    }),
  );
  const internal = await boom.request(`/agent-history/threads/${THREAD_A}/window`, {
    headers: { authorization: 'Bearer a' },
  });
  assert.equal(internal.status, 500);
  const internalBody = await internal.json();
  assert.equal(internalBody.error, 'Failed to load history window');
  assert.equal(JSON.stringify(internalBody).includes('secret_table'), false);
  assert.equal(JSON.stringify(internalBody).includes('password'), false);
});
