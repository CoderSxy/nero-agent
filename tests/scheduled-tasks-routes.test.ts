import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import type { AuthUser } from '../src/mastra/auth/service';
import { ScheduledTaskError, type ScheduledTaskService } from '../src/mastra/scheduled-tasks/service';
import { createScheduledTaskRoutes } from '../src/mastra/scheduled-tasks/routes';
import {
  isNativeSchedulePath,
  isStudioAdminRequest,
  nativeScheduleGuardMiddleware,
} from '../src/mastra/scheduled-tasks/native-guard';

function user(id: string, role: 'admin' | 'user' = 'admin'): AuthUser {
  return { id, email: `${id}@example.test`, displayName: id, roles: [role] };
}

function buildApp(routes: ApiRoute[], resolveUser: (token: string) => AuthUser | null) {
  const app = new Hono();
  for (const route of routes) {
    if (!('handler' in route) || !route.handler) throw new Error(`route ${route.path} has no handler`);
    const handler = route.handler;
    app.on(route.method, route.path, async (c, next) => {
      const requestContext = new RequestContext();
      c.set('requestContext', requestContext);
      if (route.requiresAuth !== false) {
        const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? '';
        const authed = resolveUser(token);
        if (!authed) return c.json({ error: 'Unauthorized' }, 401);
        requestContext.set('user', authed);
      }
      return handler(c, next);
    });
  }
  return app;
}

function mockService(overrides: Partial<ScheduledTaskService> = {}): ScheduledTaskService {
  const notFound = async () => { throw new ScheduledTaskError('not_found', '任务不存在'); };
  const forbidden = async () => { throw new ScheduledTaskError('forbidden', '仅管理员可管理定时任务'); };
  return {
    create: async () => ({ id: 't1' }) as never,
    get: notFound,
    edit: notFound,
    pause: notFound,
    resume: notFound,
    run: notFound,
    remove: notFound,
    list: async (owner) => {
      if (!owner.roles.includes('admin')) return forbidden();
      return { items: [], total: 0 };
    },
    runs: notFound,
    ...overrides,
  } as ScheduledTaskService;
}

test('scheduled task routes register the management contract', () => {
  const routes = createScheduledTaskRoutes(() => mockService());
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`).sort(), [
    'DELETE /agent-scheduled-tasks/:id',
    'GET /agent-scheduled-tasks',
    'GET /agent-scheduled-tasks/:id',
    'GET /agent-scheduled-tasks/:id/runs',
    'PATCH /agent-scheduled-tasks/:id',
    'POST /agent-scheduled-tasks',
    'POST /agent-scheduled-tasks/:id/pause',
    'POST /agent-scheduled-tasks/:id/resume',
    'POST /agent-scheduled-tasks/:id/run',
  ]);
});

test('scheduled task HTTP API enforces auth, admin, isolation, and body limits', async () => {
  const adminA = user('admin-a');
  const adminB = user('admin-b');
  const regular = user('user-a', 'user');
  const tokens = new Map([
    ['token-a', adminA],
    ['token-b', adminB],
    ['token-u', regular],
  ]);
  const ownedId = randomUUID();
  const service = mockService({
    list: async (owner) => {
      if (!owner.roles.includes('admin')) throw new ScheduledTaskError('forbidden', '仅管理员可管理定时任务');
      if (owner.id !== adminA.id) return { items: [], total: 0 };
      return {
        items: [{
          id: ownedId,
          ownerUserId: adminA.id,
          mastraScheduleId: 'agent_x',
          name: '晨报',
          taskType: 'cron',
          cron: '0 9 * * *',
          timezone: 'Asia/Shanghai',
          chatModelRef: 'public:11111111-1111-4111-8111-111111111111',
          memoryModelRef: 'public:11111111-1111-4111-8111-111111111111',
          startsAt: null,
          endsAt: null,
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          nextFireAt: null,
          lastFireAt: null,
          execCount: 0,
        }],
        total: 1,
      };
    },
    get: async (owner, id) => {
      if (owner.id !== adminA.id || id !== ownedId) {
        throw new ScheduledTaskError('not_found', '任务不存在');
      }
      return (await service.list(owner, { page: 1, pageSize: 10 })).items[0]!;
    },
    create: async (owner, input) => {
      if (!owner.roles.includes('admin')) throw new ScheduledTaskError('forbidden', '仅管理员可管理定时任务');
      if (!(input as { prompt?: string }).prompt?.toString().trim()) {
        throw new ScheduledTaskError('invalid_input', '提示词无效');
      }
      return { id: randomUUID(), name: 'x' } as never;
    },
    edit: async (owner, id) => {
      if (owner.id !== adminA.id || id !== ownedId) throw new ScheduledTaskError('not_found', '任务不存在');
      return { id } as never;
    },
    pause: async (owner, id) => {
      if (owner.id !== adminA.id || id !== ownedId) throw new ScheduledTaskError('not_found', '任务不存在');
      return { id, status: 'paused' } as never;
    },
    resume: async (owner, id) => {
      if (owner.id !== adminA.id || id !== ownedId) throw new ScheduledTaskError('not_found', '任务不存在');
      return { id, status: 'active' } as never;
    },
    run: async (owner, id) => {
      if (owner.id !== adminA.id || id !== ownedId) throw new ScheduledTaskError('not_found', '任务不存在');
      return { accepted: true, run: { id: 'r1' } } as never;
    },
    remove: async (owner, id) => {
      if (owner.id !== adminA.id || id !== ownedId) throw new ScheduledTaskError('not_found', '任务不存在');
    },
    runs: async (owner, id) => {
      if (owner.id !== adminA.id || id !== ownedId) throw new ScheduledTaskError('not_found', '任务不存在');
      return { items: [], total: 0 };
    },
  });
  const app = buildApp(createScheduledTaskRoutes(() => service), (token) => tokens.get(token) ?? null);
  const call = async (method: string, path: string, token?: string, json?: unknown, raw?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (json !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const response = await app.request(path, {
      method, headers, body: raw ?? (json === undefined ? undefined : JSON.stringify(json)),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  assert.equal((await call('GET', '/agent-scheduled-tasks')).status, 401);
  assert.equal((await call('GET', '/agent-scheduled-tasks', 'token-u')).status, 403);
  assert.equal((await call('GET', '/agent-scheduled-tasks', 'token-a')).status, 200);
  assert.equal((await call('GET', `/agent-scheduled-tasks/${ownedId}`, 'token-b')).status, 404);
  assert.equal((await call('PATCH', `/agent-scheduled-tasks/${ownedId}`, 'token-b', { name: 'x' })).status, 404);
  assert.equal((await call('POST', `/agent-scheduled-tasks/${ownedId}/pause`, 'token-b')).status, 404);
  assert.equal((await call('POST', `/agent-scheduled-tasks/${ownedId}/resume`, 'token-b')).status, 404);
  assert.equal((await call('POST', `/agent-scheduled-tasks/${ownedId}/run`, 'token-b')).status, 404);
  assert.equal((await call('DELETE', `/agent-scheduled-tasks/${ownedId}`, 'token-b')).status, 404);
  assert.equal((await call('GET', `/agent-scheduled-tasks/${ownedId}/runs`, 'token-b')).status, 404);
  assert.equal((await call('POST', '/agent-scheduled-tasks', 'token-a', { prompt: '   ' })).status, 400);
  assert.equal((await call('GET', '/agent-scheduled-tasks?page=0', 'token-a')).status, 400);
  assert.equal((await call('GET', '/agent-scheduled-tasks?pageSize=51', 'token-a')).status, 400);
  assert.equal((await call('POST', '/agent-scheduled-tasks', 'token-a', undefined, '{"a":1')).status, 400);
  const huge = `{"prompt":"${'x'.repeat(40_000)}"}`;
  assert.equal((await call('POST', '/agent-scheduled-tasks', 'token-a', undefined, huge)).status, 400);
});

test('native schedule guard blocks app clients and forged studio headers', async () => {
  assert.equal(isNativeSchedulePath('/api/schedules'), true);
  assert.equal(isNativeSchedulePath('/api/schedules/abc/run'), true);
  assert.equal(isNativeSchedulePath('/api/agent-scheduled-tasks'), false);

  const app = new Hono();
  app.use('*', async (c, next) => nativeScheduleGuardMiddleware.handler(c, next));
  app.all('/api/schedules', (c) => c.json({ ok: true }));
  app.all('/api/schedules/:id', (c) => c.json({ ok: true }));
  app.all('/api/schedules/:id/run', (c) => c.json({ ok: true }));
  app.all('/api/schedules/:id/pause', (c) => c.json({ ok: true }));
  app.all('/api/schedules/:id/resume', (c) => c.json({ ok: true }));

  const paths = [
    '/api/schedules',
    '/api/schedules/x',
    '/api/schedules/x/run',
    '/api/schedules/x/pause',
    '/api/schedules/x/resume',
  ];
  for (const path of paths) {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      if (method === 'PATCH' && path === '/api/schedules') continue;
      if (method === 'DELETE' && (path.endsWith('/run') || path.endsWith('/pause') || path.endsWith('/resume'))) continue;
      const forged = await app.request(path, {
        method,
        headers: {
          'x-mastra-client-type': 'studio',
          authorization: 'Bearer admin-token',
        },
      });
      assert.equal(forged.status, 403, `${method} ${path} should block forged studio header`);
    }
  }

  assert.equal(await isStudioAdminRequest(new Request('http://local/api/schedules', {
    headers: { 'x-mastra-client-type': 'studio', authorization: 'Bearer anything' },
  }), async () => user('admin')), false);

  assert.equal(await isStudioAdminRequest(new Request('http://local/api/schedules', {
    headers: { cookie: 'nero_studio_session=studio-token' },
  }), async (token) => (token === 'studio-token' ? user('admin') : null)), true);

  assert.equal(await isStudioAdminRequest(new Request('http://local/api/schedules', {
    headers: { cookie: 'nero_studio_session=studio-token' },
  }), async () => user('user-a', 'user')), false);
});
