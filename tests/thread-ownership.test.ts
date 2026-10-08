import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import { trustedAuth, type AuthContext } from '../src/mastra/auth/auth-context';
import { assertThreadOwned, ThreadGuardError } from '../src/mastra/auth/thread-guard';
import { authorizeThreadRoute, extractThreadId } from '../src/mastra/auth/authorization';
import type { AuthUser } from '../src/mastra/auth/service';

const MASTRA_USER_KEY = 'mastra__user';
const USER_A = '73ff1799-b0e1-4bce-92d0-579061494064';
const USER_B = 'a157a4c1-413f-4d1c-83f1-bbf104573101';
const THREAD_A = '5410fb0e-b0a9-4f26-b3a9-b3f96c94e015';
const THREAD_B = '0e8ab899-a799-42dc-a9e6-c77a3a9547e9';

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

function authFor(id: string): AuthContext {
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_USER_KEY, user(id));
  return trustedAuth(requestContext);
}

function lookup(threads: Array<{ id: string; resourceId: string | null }>) {
  return {
    getThreadById: async ({ threadId }: { threadId: string }) =>
      threads.find(thread => thread.id === threadId) ?? null,
  };
}

test('assertThreadOwned rejects a missing thread', async () => {
  await assert.rejects(
    () => assertThreadOwned(authFor(USER_A), THREAD_A, lookup([])),
    (error: unknown) => error instanceof ThreadGuardError && error.status === 404,
  );
});

test('assertThreadOwned rejects a thread with empty resourceId', async () => {
  await assert.rejects(
    () => assertThreadOwned(authFor(USER_A), THREAD_A, lookup([{ id: THREAD_A, resourceId: '' }])),
    (error: unknown) => error instanceof ThreadGuardError && error.status === 403,
  );
});

test('assertThreadOwned rejects a thread owned by another user', async () => {
  await assert.rejects(
    () => assertThreadOwned(authFor(USER_A), THREAD_B, lookup([{ id: THREAD_B, resourceId: USER_B }])),
    (error: unknown) => error instanceof ThreadGuardError && error.status === 403,
  );
});

test('assertThreadOwned returns the owned thread for the authenticated user', async () => {
  const owned = await assertThreadOwned(
    authFor(USER_A),
    THREAD_A,
    lookup([{ id: THREAD_A, resourceId: USER_A }]),
  );
  assert.equal(owned.id, THREAD_A);
  assert.equal(owned.resourceId, USER_A);
});

test('extractThreadId reads path, query, body and memory.thread', () => {
  assert.equal(extractThreadId('GET', `/api/memory/threads/${THREAD_A}`, {}, {}), THREAD_A);
  assert.equal(extractThreadId('GET', '/api/memory/threads', { threadId: THREAD_A }, {}), THREAD_A);
  assert.equal(extractThreadId('POST', '/api/agents/agent/stream', {}, { memory: { thread: THREAD_B } }), THREAD_B);
  assert.equal(extractThreadId('POST', '/api/agents/agent/approve-tool-call', {}, { threadId: THREAD_A }), THREAD_A);
  assert.equal(extractThreadId('GET', '/api/memory/threads', {}, {}), undefined);
});

async function runGuard(input: {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  user?: AuthUser;
  threads?: Array<{ id: string; resourceId: string | null }>;
}) {
  const requestContext = new RequestContext();
  if (input.user) requestContext.set(MASTRA_USER_KEY, input.user);
  let nextCalled = false;
  const threads = input.threads ?? [{ id: THREAD_B, resourceId: USER_B }];
  const raw = new Request(`http://localhost${input.path}`, {
    method: input.method,
    headers: input.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const result = await authorizeThreadRoute.handler({
    req: { method: input.method, path: input.path, query: input.query ?? {}, raw },
    get: (key: string) => key === 'requestContext' ? requestContext : undefined,
    json: (body: unknown, status?: number) => Response.json(body, { status }),
  }, async () => {
    nextCalled = true;
  }, lookup(threads));
  return { nextCalled, result };
}

test('authorizeThreadRoute blocks A from B thread get/list messages/update/delete/stream/approve/resume', async () => {
  const a = user(USER_A);
  const cases: Array<{ method: string; path: string; body?: unknown }> = [
    { method: 'GET', path: `/api/memory/threads/${THREAD_B}` },
    { method: 'GET', path: `/api/memory/threads/${THREAD_B}/messages` },
    { method: 'PATCH', path: `/api/memory/threads/${THREAD_B}` },
    { method: 'DELETE', path: `/api/memory/threads/${THREAD_B}` },
    { method: 'POST', path: '/api/agents/agent/stream', body: { memory: { thread: THREAD_B, resource: USER_B } } },
    { method: 'POST', path: '/api/agents/agent/approve-tool-call', body: { threadId: THREAD_B, runId: 'fake' } },
    { method: 'POST', path: '/api/agents/agent/resume-stream', body: { threadId: THREAD_B, runId: 'fake', resumeData: {} } },
  ];
  for (const item of cases) {
    const { nextCalled, result } = await runGuard({ ...item, user: a });
    assert.equal(nextCalled, false, `${item.method} ${item.path}`);
    assert.equal(result?.status, 403, `${item.method} ${item.path}`);
  }
});

test('authorizeThreadRoute ignores a forged body/query resourceId', async () => {
  const { nextCalled, result } = await runGuard({
    method: 'POST',
    path: '/api/agents/agent/stream',
    user: user(USER_A),
    body: { memory: { thread: THREAD_B, resource: USER_A }, resourceId: USER_A },
  });
  assert.equal(nextCalled, false);
  assert.equal(result?.status, 403);
});

test('authorizeThreadRoute allows the owner and skips routes without a threadId', async () => {
  const owned = await runGuard({
    method: 'GET',
    path: `/api/memory/threads/${THREAD_A}`,
    user: user(USER_A),
    threads: [{ id: THREAD_A, resourceId: USER_A }],
  });
  assert.equal(owned.nextCalled, true);

  const list = await runGuard({
    method: 'GET',
    path: '/api/memory/threads',
    user: user(USER_A),
  });
  assert.equal(list.nextCalled, true);

  const create = await runGuard({
    method: 'POST',
    path: '/api/memory/threads',
    user: user(USER_A),
    body: { resourceId: USER_B, title: 'forged' },
  });
  assert.equal(create.nextCalled, true);
});

test('a first stream may create its authenticated user thread', async () => {
  const initial = await runGuard({
    method: 'POST',
    path: '/api/agents/agent/stream',
    user: user(USER_A),
    body: { memory: { thread: THREAD_A, resource: USER_B } },
    threads: [],
  });
  assert.equal(initial.nextCalled, true);
  assert.equal(initial.result, undefined);

  const missingRead = await runGuard({
    method: 'GET',
    path: `/api/memory/threads/${THREAD_A}`,
    user: user(USER_A),
    threads: [],
  });
  assert.equal(missingRead.result?.status, 404);
});

test('authorizeThreadRoute calls a Hono query method with its request receiver', async () => {
  const request = {
    method: 'GET',
    path: '/auth/me',
    raw: new Request('http://localhost/auth/me'),
    query(this: { raw: Request }, key: string) {
      return new URL(this.raw.url).searchParams.get(key) ?? undefined;
    },
  };
  let reached = false;
  await authorizeThreadRoute.handler({
    req: request,
    get: () => undefined,
  }, async () => { reached = true; });
  assert.equal(reached, true);
});

test('thread authorization validates bearer before Mastra attaches requestContext', async () => {
  const raw = new Request(`http://localhost/api/memory/threads/${THREAD_A}`, {
    headers: { authorization: 'Bearer valid-token' },
  });
  let reached = false;
  await authorizeThreadRoute.handler({
    req: { method: 'GET', path: `/api/memory/threads/${THREAD_A}`, raw, query: {} },
    get: () => undefined,
  }, async () => { reached = true; }, lookup([{ id: THREAD_A, resourceId: USER_A }]),
  async token => token === 'valid-token' ? user(USER_A) : null);
  assert.equal(reached, true);
});

test('thread authorization validates bearer when requestContext has no user yet', async () => {
  const requestContext = new RequestContext();
  const raw = new Request(`http://localhost/api/memory/threads/${THREAD_A}`, {
    headers: { authorization: 'Bearer valid-token' },
  });
  let reached = false;
  await authorizeThreadRoute.handler({
    req: { method: 'GET', path: `/api/memory/threads/${THREAD_A}`, raw, query: {} },
    get: (key: string) => key === 'requestContext' ? requestContext : undefined,
  }, async () => { reached = true; }, lookup([{ id: THREAD_A, resourceId: USER_A }]),
  async token => token === 'valid-token' ? user(USER_A) : null);
  assert.equal(reached, true);
  assert.equal(requestContext.get(MASTRA_USER_KEY)?.id, USER_A);
});

test('Studio thread authorization prefers its session cookie over a stale bearer', async () => {
  const requestContext = new RequestContext();
  const raw = new Request(`http://localhost/api/memory/threads/${THREAD_A}`, {
    headers: {
      authorization: 'Bearer stale-token',
      cookie: 'nero_studio_session=valid-token',
      'x-mastra-client-type': 'studio',
    },
  });
  let reached = false;
  const result = await authorizeThreadRoute.handler({
    req: { method: 'GET', path: `/api/memory/threads/${THREAD_A}`, raw, query: {} },
    get: (key: string) => key === 'requestContext' ? requestContext : undefined,
  }, async () => { reached = true; }, lookup([{ id: THREAD_A, resourceId: USER_A }]),
  async token => token === 'valid-token' ? { ...user(USER_A), roles: ['admin'] } : null);
  assert.equal(result, undefined);
  assert.equal(reached, true);
  assert.equal(requestContext.get(MASTRA_USER_KEY)?.id, USER_A);
});

test('thread authorization does not accept a Studio cookie without the Studio header', async () => {
  const raw = new Request(`http://localhost/api/memory/threads/${THREAD_A}`, {
    headers: { cookie: 'nero_studio_session=valid-token' },
  });
  let reached = false;
  const result = await authorizeThreadRoute.handler({
    req: { method: 'GET', path: `/api/memory/threads/${THREAD_A}`, raw, query: {} },
    get: () => undefined,
  }, async () => { reached = true; }, lookup([{ id: THREAD_A, resourceId: USER_A }]),
  async token => token === 'valid-token' ? { ...user(USER_A), roles: ['admin'] } : null);
  assert.equal(result?.status, 401);
  assert.equal(reached, false);
});

test('thread authorization rejects an invalid bearer when requestContext has no user', async () => {
  const requestContext = new RequestContext();
  const raw = new Request(`http://localhost/api/memory/threads/${THREAD_A}`, {
    headers: { authorization: 'Bearer invalid-token' },
  });
  let reached = false;
  const result = await authorizeThreadRoute.handler({
    req: { method: 'GET', path: `/api/memory/threads/${THREAD_A}`, raw, query: {} },
    get: (key: string) => key === 'requestContext' ? requestContext : undefined,
  }, async () => { reached = true; }, lookup([{ id: THREAD_A, resourceId: USER_A }]),
  async () => null);
  assert.equal(reached, false);
  assert.equal(result?.status, 401);
  assert.equal(requestContext.get(MASTRA_USER_KEY), undefined);
});

const LIVE = process.env.MASTRA_HTTP_BASE ?? 'http://127.0.0.1:4111';

async function liveAvailable() {
  try {
    const response = await fetch(`${LIVE}/api/agents`, { signal: AbortSignal.timeout(500) });
    return response.status === 401 || response.ok;
  } catch {
    return false;
  }
}

test('live HTTP: A cannot read or mutate B threads on native routes',
  { skip: !(await liveAvailable()) }, async () => {
  const login = async (email: string, password: string) => {
    const response = await fetch(`${LIVE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ token: string; user: AuthUser }>;
  };
  const accounts = await import('node:fs/promises').then(fs => fs.readFile('.local-accounts', 'utf8'));
  const adminMatch = accounts.match(/admin: (\S+) \/ (\S+)/);
  const userMatch = accounts.match(/user: (\S+) \/ (\S+)/);
  if (!adminMatch || !userMatch) {
    throw new Error('missing local accounts for live HTTP probe');
  }
  const admin = await login(adminMatch[1], adminMatch[2]);
  const a = await login(userMatch[1], userMatch[2]);
  const create = async (token: string, resourceId: string) => {
    const response = await fetch(`${LIVE}/api/memory/threads?agentId=agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ resourceId, title: 'ownership-probe' }),
    });
    assert.equal(response.status, 200);
    return (await response.json() as { id: string }).id;
  };
  const adminThread = await create(admin.token, admin.user.id);
  const call = (method: string, path: string, body?: unknown) => fetch(`${LIVE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${a.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal((await call('GET', `/api/memory/threads/${adminThread}?agentId=agent`)).status, 403);
  assert.equal((await call('GET', `/api/memory/threads/${adminThread}/messages?agentId=agent`)).status, 403);
  assert.equal((await call('PATCH', `/api/memory/threads/${adminThread}?agentId=agent`, { title: 'x' })).status, 403);
  assert.equal((await call('DELETE', `/api/memory/threads/${adminThread}?agentId=agent`)).status, 403);
  assert.equal((await call('POST', '/api/agents/agent/stream', {
    messages: [{ role: 'user', content: 'x' }],
    memory: { thread: adminThread, resource: admin.user.id },
  })).status, 403);
  const approve = await call('POST', '/api/agents/agent/approve-tool-call', {
    threadId: adminThread, runId: 'fake', toolCallId: 'fake',
  });
  assert.ok(approve.status === 403 || approve.status >= 400);
  const resume = await call('POST', '/api/agents/agent/resume-stream', {
    threadId: adminThread, runId: 'fake', resumeData: {},
  });
  assert.ok(resume.status === 403 || resume.status >= 400);
});
