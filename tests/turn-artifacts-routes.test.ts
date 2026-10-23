import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import { getPool } from '../src/mastra/auth/db';
import type { AuthUser } from '../src/mastra/auth/service';
import { createTurnArtifactRoutes } from '../src/mastra/files/artifacts/routes';
import { ArtifactRepository } from '../src/mastra/files/artifacts/repository';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THREAD_A = 'thread-artifacts-a';
const THREAD_B = 'thread-artifacts-b';
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

function safeDatabase(): boolean {
  try {
    const parsed = new URL(process.env.DATABASE_URL ?? '');
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

test('turn-artifacts routes enforce auth, ownership, and limit', async () => {
  process.env.USER_FILES_ENABLED = 'true';
  const app = buildApp(createTurnArtifactRoutes(lookup()));
  assert.equal((await app.request('/current-workspace/turn-artifacts?threadId=' + THREAD_A)).status, 401);

  const denied = await app.request(`/current-workspace/turn-artifacts?threadId=${THREAD_A}`, {
    headers: { authorization: 'Bearer b' },
  });
  assert.equal(denied.status, 403);

  const adminDenied = await app.request(`/current-workspace/turn-artifacts?threadId=${THREAD_B}`, {
    headers: { authorization: 'Bearer admin' },
  });
  assert.equal(adminDenied.status, 403);

  const badLimit = await app.request(`/current-workspace/turn-artifacts?threadId=${THREAD_A}&limit=0`, {
    headers: { authorization: 'Bearer a' },
  });
  assert.equal(badLimit.status, 400);

  const badLimit2 = await app.request(`/current-workspace/turn-artifacts?threadId=${THREAD_A}&limit=101`, {
    headers: { authorization: 'Bearer a' },
  });
  assert.equal(badLimit2.status, 400);

  const empty = await app.request(`/current-workspace/turn-artifacts?threadId=${THREAD_A}`, {
    headers: { authorization: 'Bearer a' },
  });
  // May be 200 empty or 500 if DB missing — when DB available expect 200
  if (safeDatabase()) {
    assert.equal(empty.status, 200);
    const body = await empty.json() as { items: unknown[]; nextCursor: null };
    assert.deepEqual(body.items, []);
    assert.equal(body.nextCursor, null);
  }
});

test('turn-artifacts pagination returns owned runs only', {
  skip: safeDatabase() ? false : 'needs loopback DATABASE_URL',
}, async () => {
  process.env.USER_FILES_ENABLED = 'true';
  const pool = getPool();
  const repo = new ArtifactRepository(pool);
  const client = await pool.connect();
  const thread = `ta-route-${randomUUID()}`;
  try {
    await client.query(
      `INSERT INTO app_users (id, email, display_name, password_hash)
       VALUES ($1, $2, 'A', 'x'), ($3, $4, 'B', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [USER_A, `a-${USER_A}@example.test`, USER_B, `b-${USER_B}@example.test`],
    );
    for (let i = 0; i < 3; i += 1) {
      const id = { userId: USER_A, threadId: thread, runId: `route-run-${i}` };
      await repo.ensureArtifactRun(id);
      await repo.setArtifactRunState(id, i === 0 ? 'cancelled' : 'completed');
    }
    const customLookup = {
      getThreadById: async ({ threadId }: { threadId: string }) =>
        threadId === thread ? { id: thread, resourceId: USER_A } : null,
    };
    const app = buildApp(createTurnArtifactRoutes(customLookup));
    const res = await app.request(`/current-workspace/turn-artifacts?threadId=${thread}&limit=2`, {
      headers: { authorization: 'Bearer a' },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      items: Array<{ runId: string; state: string }>;
      nextCursor: string | null;
    };
    assert.equal(body.items.length, 2);
    assert.ok(body.nextCursor);
    assert.ok(body.items.every((item) => item.state === 'completed' || item.state === 'cancelled'));
  } finally {
    await client.query(`DELETE FROM app_agent_artifact_runs WHERE thread_id = $1`, [thread]);
    client.release();
  }
});
