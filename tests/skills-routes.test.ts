/**
 * Task 8: skill HTTP route contract + identity boundary (mock service).
 * Model/tool tests cannot substitute for these HTTP checks.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import type { AuthUser } from '../src/mastra/auth/service.ts';
import { SkillPolicyError } from '../src/mastra/skills/policy.ts';
import { createSkillRoutes } from '../src/mastra/skills/routes.ts';
import type { SkillService } from '../src/mastra/skills/service.ts';

const MASTRA_USER_KEY = 'mastra__user';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const SKILL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function user(id: string, role: 'admin' | 'user' = 'user'): AuthUser {
  return { id, email: `${id}@example.test`, displayName: id.slice(0, 8), roles: [role] };
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
        if (!authed) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Unauthorized' } }, 401);
        requestContext.set(MASTRA_USER_KEY, authed);
        // Forged client fields must never become identity
        requestContext.set('user', { id: USER_A, roles: ['admin'] });
        requestContext.set('userId', USER_A);
        requestContext.set('roles', ['admin']);
        requestContext.set('owner', USER_A);
      }
      return handler(c, next);
    });
  }
  return app;
}

function mockService(overrides: Partial<SkillService> = {}): SkillService {
  const forbidden = async () => {
    throw new SkillPolicyError('FORBIDDEN', 'denied', 403);
  };
  const unavailable = async () => {
    throw new SkillPolicyError('SKILL_UNAVAILABLE', 'Skill is unavailable', 404);
  };
  const base: SkillService = {
    listAvailable: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
    listManageable: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
    load: unavailable as never,
    loadById: unavailable as never,
    read: unavailable as never,
    search: unavailable as never,
    createDraft: async () => ({ skill: { id: SKILL_A } as never, version: { version: 1 } as never }),
    createWorkingDraft: forbidden as never,
    getManageDetail: forbidden as never,
    saveDraft: forbidden as never,
    saveFile: forbidden as never,
    deleteDraftFile: forbidden as never,
    setMetadata: forbidden as never,
    setEnabled: forbidden as never,
    deleteSkill: forbidden as never,
    listEvents: forbidden as never,
    listVersions: forbidden as never,
    deleteVersion: forbidden as never,
    listFiles: forbidden as never,
    readFileContent: forbidden as never,
    downloadFile: forbidden as never,
    exportZip: forbidden as never,
    publish: forbidden as never,
    rollback: forbidden as never,
    listGroups: async () => [],
    createGroup: forbidden as never,
    updateGroup: forbidden as never,
    deleteGroup: forbidden as never,
    listAudiences: forbidden as never,
    createAudience: forbidden as never,
    updateAudience: forbidden as never,
    deleteAudience: forbidden as never,
    searchUsers: async () => [],
    listAvailableShortcuts: async () => ({ items: [] }),
    getShortcut: forbidden as never,
    putShortcut: forbidden as never,
    getSkillHealth: forbidden as never,
    recheckSkillHealth: forbidden as never,
    ...overrides,
  };
  return base;
}

test('skill routes register base CRUD before :id and register shortcuts ahead of :id', () => {
  const paths = createSkillRoutes(() => mockService()).map((r) => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /agent-skills/available'));
  assert.ok(paths.includes('GET /agent-skills/groups'));
  assert.ok(paths.includes('GET /agent-skills/audiences'));
  assert.ok(paths.includes('GET /agent-skills/users'));
  assert.ok(paths.includes('GET /agent-skills/:id/files/download'));
  assert.ok(paths.includes('POST /agent-skills/:id/publish'));
  assert.ok(paths.includes('GET /agent-skills/:id/export'));
  assert.ok(paths.includes('GET /agent-skills/shortcuts/available'));
  assert.ok(paths.includes('PUT /agent-skills/:id/shortcut'));
  assert.ok(paths.includes('GET /agent-skills/:id/shortcut'));
  const shortcutsIdx = paths.indexOf('GET /agent-skills/shortcuts/available');
  const availableIdx = paths.indexOf('GET /agent-skills/available');
  const idIdx = paths.indexOf('GET /agent-skills/:id');
  assert.ok(shortcutsIdx >= 0 && idIdx >= 0 && shortcutsIdx < idIdx);
  assert.ok(availableIdx >= 0 && availableIdx < idIdx);
});

test('skill HTTP enforces auth, UUID, disabled gate, body limit, Content-Disposition', async () => {
  const prev = process.env.AGENT_SKILLS_ENABLED;
  process.env.AGENT_SKILLS_ENABLED = 'true';
  try {
    const seen: Array<{ actorId: string; op: string }> = [];
    const service = mockService({
      listAvailable: async (actor) => {
        seen.push({ actorId: actor.userId, op: 'available' });
        return { items: [], total: 0, page: 1, pageSize: 20 };
      },
      getManageDetail: async (actor, id) => {
        seen.push({ actorId: actor.userId, op: `detail:${id}` });
        if (actor.userId === USER_B) {
          throw new SkillPolicyError('FORBIDDEN', 'Skill draft is not visible', 403);
        }
        if (actor.userId !== USER_A && actor.userId !== ADMIN) {
          throw new SkillPolicyError('SKILL_UNAVAILABLE', 'Skill is unavailable', 404);
        }
        return {
          skill: { id: SKILL_A, revision: '1' } as never,
          draft: actor.userId === USER_B ? null : ({ version: 2, skillMd: 'draft' } as never),
          published: { version: 1 } as never,
          canEdit: actor.userId === USER_A || actor.userId === ADMIN,
          canPublish: actor.userId === USER_A || actor.userId === ADMIN,
          canManage: actor.userId === USER_A || actor.userId === ADMIN,
        };
      },
      listVersions: async (actor) => {
        if (actor.userId === USER_B) {
          throw new SkillPolicyError('FORBIDDEN', 'Skill draft is not visible', 403);
        }
        return [{ version: 1, state: 'published' } as never];
      },
      downloadFile: async (actor) => {
        seen.push({ actorId: actor.userId, op: 'download' });
        if (actor.userId === USER_B || actor.userId === ADMIN) {
          // use-only B ok for published; admin without use still may manage-download in mock —
          // identity check: forged headers must not become A
          if (actor.userId !== USER_B && actor.userId !== ADMIN && actor.userId !== USER_A) {
            throw new SkillPolicyError('SKILL_UNAVAILABLE', 'Skill is unavailable', 404);
          }
        }
        return {
          bytes: new TextEncoder().encode('bin'),
          path: 'assets/x.bin',
          mimeType: 'application/octet-stream',
          isText: false,
        };
      },
      listAudiences: async (actor) => {
        if (!actor.roles.includes('admin')) {
          throw new SkillPolicyError('FORBIDDEN', 'Admin permission required', 403);
        }
        return [];
      },
      searchUsers: async (actor, q) => {
        if (
          !actor.roles.includes('admin')
          && actor.userId !== USER_A
        ) {
          throw new SkillPolicyError('FORBIDDEN', 'Admin or skill owner permission required', 403);
        }
        if (q.length < 1 || q.length > 64) {
          throw new SkillPolicyError('FORBIDDEN', 'q length out of range', 400);
        }
        return [{ id: USER_B, displayName: 'picker' }];
      },
      createDraft: async (actor, input) => {
        seen.push({ actorId: actor.userId, op: `create:${input.name}` });
        return {
          skill: { id: SKILL_A, ownerUserId: actor.userId, revision: '1' } as never,
          version: { version: 1 } as never,
        };
      },
    });

    const tokens = new Map([
      ['a', user(USER_A)],
      ['b', user(USER_B)],
      ['admin', user(ADMIN, 'admin')],
    ]);
    const app = buildApp(createSkillRoutes(() => service), (token) => tokens.get(token) ?? null);
    const call = async (
      method: string,
      path: string,
      token?: string,
      init: RequestInit = {},
    ) => {
      const headers = new Headers(init.headers);
      if (token) headers.set('authorization', `Bearer ${token}`);
      return app.request(path, { ...init, method, headers });
    };

    // anon
    assert.equal((await call('GET', '/agent-skills/available')).status, 401);

    // forged bearer that only sets non-trusted keys → 401
    assert.equal((await call('GET', '/agent-skills/available', 'forged')).status, 401);

    // trusted identity: forged requestContext user/roles do not elevate B
    const detailB = await call('GET', `/agent-skills/${SKILL_A}`, 'b');
    assert.equal(detailB.status, 403);
    const bodyB = await detailB.json() as { error: { code: string } };
    assert.equal(bodyB.error.code, 'FORBIDDEN');

    const versionsB = await call('GET', `/agent-skills/${SKILL_A}/versions`, 'b');
    assert.equal(versionsB.status, 403);

    const audiencesB = await call('GET', '/agent-skills/audiences', 'b');
    assert.equal(audiencesB.status, 403);

    const audiencesAdmin = await call('GET', '/agent-skills/audiences', 'admin');
    assert.equal(audiencesAdmin.status, 200);

    const usersB = await call('GET', '/agent-skills/users?q=picker', 'b');
    assert.equal(usersB.status, 403);
    const usersOwner = await call('GET', '/agent-skills/users?q=picker', 'a');
    assert.equal(usersOwner.status, 200);
    const usersAdmin = await call('GET', '/agent-skills/users?q=picker', 'admin');
    assert.equal(usersAdmin.status, 200);

    // static /available not swallowed by /:id
    const available = await call('GET', '/agent-skills/available', 'a');
    assert.equal(available.status, 200);
    assert.ok(seen.some((s) => s.op === 'available' && s.actorId === USER_A));

    // invalid UUID
    assert.equal((await call('GET', '/agent-skills/not-a-uuid', 'a')).status, 400);

    // download Content-Disposition safe
    const dl = await call(
      'GET',
      `/agent-skills/${SKILL_A}/files/download?version=1&path=assets/x.bin`,
      'a',
    );
    assert.equal(dl.status, 200);
    const cd = dl.headers.get('content-disposition') ?? '';
    assert.match(cd, /attachment;/);
    assert.match(cd, /filename\*=UTF-8''/);
    assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');

    // JSON body limit
    const huge = `{"name":"x","description":"${'y'.repeat(SKILL_LIMITS_JSON)}"}`;
    const oversized = await call('POST', '/agent-skills', 'a', {
      headers: { 'content-type': 'application/json', 'content-length': String(huge.length) },
      body: huge,
    });
    assert.equal(oversized.status, 413);

    // create uses trusted actor A even if body forges owner
    const created = await call('POST', '/agent-skills', 'a', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'demo-skill',
        description: 'd',
        ownerUserId: USER_B,
        roles: ['admin'],
      }),
    });
    assert.equal(created.status, 201);
    assert.ok(seen.some((s) => s.op === 'create:demo-skill' && s.actorId === USER_A));
  } finally {
    if (prev === undefined) delete process.env.AGENT_SKILLS_ENABLED;
    else process.env.AGENT_SKILLS_ENABLED = prev;
  }
});

const SKILL_LIMITS_JSON = 256 * 1024 + 8;

test('skill routes return SKILLS_DISABLED when master switch off', async () => {
  const prev = process.env.AGENT_SKILLS_ENABLED;
  process.env.AGENT_SKILLS_ENABLED = 'false';
  try {
    const app = buildApp(createSkillRoutes(() => mockService()), () => user(USER_A));
    const res = await app.request('/agent-skills/available', {
      headers: { authorization: 'Bearer x' },
    });
    assert.equal(res.status, 503);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'SKILLS_DISABLED');
  } finally {
    if (prev === undefined) delete process.env.AGENT_SKILLS_ENABLED;
    else process.env.AGENT_SKILLS_ENABLED = prev;
  }
});

test('If-Match and expectedRevision must agree', async () => {
  const prev = process.env.AGENT_SKILLS_ENABLED;
  process.env.AGENT_SKILLS_ENABLED = 'true';
  try {
    let captured: string | undefined;
    const service = mockService({
      setEnabled: async (_actor, input) => {
        captured = input.expectedRevision;
        return { id: SKILL_A, revision: '2' } as never;
      },
    });
    const app = buildApp(createSkillRoutes(() => service), () => user(USER_A));
    const mismatch = await app.request(`/agent-skills/${SKILL_A}/enable`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer a',
        'content-type': 'application/json',
        'if-match': '"1"',
      },
      body: JSON.stringify({ expectedRevision: '9' }),
    });
    assert.equal(mismatch.status, 400);

    const ok = await app.request(`/agent-skills/${SKILL_A}/enable`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer a',
        'content-type': 'application/json',
        'if-match': '"3"',
      },
      body: JSON.stringify({ expectedRevision: '3' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(captured, '3');
  } finally {
    if (prev === undefined) delete process.env.AGENT_SKILLS_ENABLED;
    else process.env.AGENT_SKILLS_ENABLED = prev;
  }
});

test('skill health routes hide missing skills, reject repair without manage, and surface checking', async () => {
  const prev = process.env.AGENT_SKILLS_ENABLED;
  process.env.AGENT_SKILLS_ENABLED = 'true';
  try {
    const calls: Array<Record<string, unknown>> = [];
    const service = mockService({
      getSkillHealth: async (actor) => {
        if (actor.userId !== USER_A) throw new SkillPolicyError('FORBIDDEN', 'Skill not found', 404);
        return {
          skillId: SKILL_A, version: 1, manifestHash: 'abc', status: 'healthy' as const,
          checkedAt: null, safeCode: null, resourceCount: 0, missingCount: 0, corruptCount: 0,
        };
      },
      recheckSkillHealth: async (actor, input) => {
        calls.push({ ...input, userId: actor.userId });
        if (!actor.roles.includes('admin') && input.repair) {
          throw new SkillPolicyError('FORBIDDEN', 'Skill repair requires manage permission', 403);
        }
        if (input.repair) return { status: 'done' as const, report: { skillId: SKILL_A, version: 1, manifestHash: 'abc', status: 'repairable' as const, checkedAt: null, safeCode: 'RELEASE_INCOMPLETE', resourceCount: 0, missingCount: 0, corruptCount: 0 } };
        return { status: 'checking' as const };
      },
    });
    const anonymous = await buildApp(createSkillRoutes(() => service), () => null)
      .request(`/agent-skills/${SKILL_A}/health`);
    assert.equal(anonymous.status, 401);
    const hidden = await buildApp(createSkillRoutes(() => service), token => token === 'b' ? user(USER_B) : null)
      .request(`/agent-skills/${SKILL_A}/health`, { headers: { authorization: 'Bearer b' } });
    assert.equal(hidden.status, 404);
    assert.equal(JSON.stringify(await hidden.json()).includes(SKILL_A), false);
    const userApp = buildApp(createSkillRoutes(() => service), () => user(USER_A));
    const repair = await userApp.request(`/agent-skills/${SKILL_A}/health/recheck`, {
      method: 'POST', headers: { authorization: 'Bearer a', 'content-type': 'application/json' },
      body: JSON.stringify({ repair: true, skillMd: 'nope' }),
    });
    assert.equal(repair.status, 403);
    const checking = await userApp.request(`/agent-skills/${SKILL_A}/health/recheck`, {
      method: 'POST', headers: { authorization: 'Bearer a', 'content-type': 'application/json' },
      body: JSON.stringify({ repair: false }),
    });
    assert.equal(checking.status, 202);
    const adminApp = buildApp(createSkillRoutes(() => service), () => user(ADMIN, 'admin'));
    const managed = await adminApp.request(`/agent-skills/${SKILL_A}/health/recheck`, {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ repair: true, version: 1 }),
    });
    assert.equal(managed.status, 200);
    assert.equal(calls.some(call => 'skillMd' in call), false);
    assert.equal(calls.filter(call => call.repair === true).length, 2);
  } finally {
    if (prev === undefined) delete process.env.AGENT_SKILLS_ENABLED;
    else process.env.AGENT_SKILLS_ENABLED = prev;
  }
});
