/**
 * Task 8: real HTTP identity matrix A / B / admin / anon against SkillService + DB.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import { getPool } from '../src/mastra/auth/db.ts';
import { createUser, type AuthUser } from '../src/mastra/auth/service.ts';
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';
import { createSkillRepository } from '../src/mastra/skills/repository.ts';
import { createSkillRoutes } from '../src/mastra/skills/routes.ts';
import { createSkillService } from '../src/mastra/skills/service.ts';
import { createSkillVersionService, publishSkill } from '../src/mastra/skills/versions.ts';
import type { SkillActor } from '../src/mastra/skills/types.ts';

const MASTRA_USER_KEY = 'mastra__user';

function resolveSafeTestDatabaseUrl(): { ok: true; url: string } | { ok: false; reason: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL unset; skills HTTP integration skipped' };
  }
  try {
    const parsed = new URL(raw);
    const hostOk = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    const portOk = parsed.port === '5433';
    const dbOk = parsed.pathname.replace(/^\//, '') === 'nero_agent';
    if (!hostOk || !portOk || !dbOk) {
      return {
        ok: false,
        reason:
          'BLOCKED_ENV: DATABASE_URL is not the local db:local:setup target '
          + '(expected 127.0.0.1|localhost:5433/nero_agent)',
      };
    }
    return { ok: true, url: raw };
  } catch {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL is not a valid URL' };
  }
}

const safeDb = resolveSafeTestDatabaseUrl();
const hasSafeDatabase = safeDb.ok;

function buildApp(routes: ApiRoute[], usersByToken: Map<string, AuthUser>) {
  const app = new Hono();
  for (const route of routes) {
    if (!('handler' in route) || !route.handler) throw new Error(`route ${route.path} has no handler`);
    const handler = route.handler;
    app.on(route.method, route.path, async (c, next) => {
      const requestContext = new RequestContext();
      c.set('requestContext', requestContext);
      if (route.requiresAuth !== false) {
        const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? '';
        const authed = usersByToken.get(token);
        if (!authed) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Unauthorized' } }, 401);
        requestContext.set(MASTRA_USER_KEY, authed);
        requestContext.set('user', { id: randomUUID(), roles: ['admin'] });
        requestContext.set('userId', randomUUID());
        requestContext.set('roles', ['admin']);
      }
      return handler(c, next);
    });
  }
  return app;
}

test('skills HTTP env gate documents BLOCKED_ENV when DB is unsafe or missing', () => {
  if (hasSafeDatabase) {
    assert.equal(safeDb.ok, true);
    return;
  }
  assert.match(safeDb.reason, /^BLOCKED_ENV:/);
  console.log(safeDb.reason);
});

test(
  'HTTP identity matrix: available/detail/draft/history/files/download/export/publish/audiences',
  { skip: !hasSafeDatabase },
  async () => {
    assert.ok(hasSafeDatabase, safeDb.ok ? 'ok' : safeDb.reason);
    const prev = process.env.AGENT_SKILLS_ENABLED;
    process.env.AGENT_SKILLS_ENABLED = 'true';
    const storageRoot = await mkdtemp(join(tmpdir(), 'skills-http-'));
    const pool = getPool();
    const suffix = randomUUID().slice(0, 8);
    const userA = await createUser({
      email: `skill-a-${suffix}@example.test`,
      displayName: `SkillA ${suffix}`,
      password: 'test-password-a',
      role: 'user',
    });
    const userB = await createUser({
      email: `skill-b-${suffix}@example.test`,
      displayName: `SkillB ${suffix}`,
      password: 'test-password-b',
      role: 'user',
    });
    const admin = await createUser({
      email: `skill-admin-${suffix}@example.test`,
      displayName: `SkillAdmin ${suffix}`,
      password: 'test-password-admin',
      role: 'admin',
    });

    const repo = createSkillRepository(pool);
    const blobStore = createBlobStore({ root: storageRoot });
    const releaseStore = createReleaseStore({ root: storageRoot, blobStore });
    const versions = createSkillVersionService({ repository: repo, blobStore, releaseStore, pool });
    const service = createSkillService({
      repository: repo,
      blobStore,
      releaseStore,
      versionService: versions,
      pool,
    });

    const actorA: SkillActor = { userId: userA.id, roles: ['user'] };
    const name = `http-demo-${suffix}`;
    const created = await service.createDraft(actorA, {
      name,
      description: 'HTTP identity matrix skill',
      skillMd: `---\nname: ${name}\ndescription: HTTP identity matrix skill\n---\n\n# Demo\n`,
    });
    const skillId = created.skill.id;

    // grant B use-only
    await pool.query(
      `INSERT INTO app_skill_grants (skill_id, user_id, permission) VALUES ($1, $2, 'use')`,
      [skillId, userB.id],
    );

    const published = await publishSkill(versions, actorA, {
      skillId,
      version: created.version.version,
      expectedRevision: created.skill.revision,
      remark: 'v1',
    });
    const enabled = await service.setEnabled(actorA, {
      skillId,
      expectedRevision: published.skill.revision,
      enabled: true,
    });

    // working draft after publish
    const draft = await service.createWorkingDraft(actorA, {
      skillId,
      expectedRevision: enabled.revision,
    });

    const tokens = new Map([
      ['a', userA],
      ['b', userB],
      ['admin', admin],
    ]);
    const app = buildApp(createSkillRoutes(() => service), tokens);
    const call = async (method: string, path: string, token?: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (token) headers.set('authorization', `Bearer ${token}`);
      return app.request(path, { ...init, method, headers });
    };

    try {
      assert.equal((await call('GET', '/agent-skills/available')).status, 401);

      const q = encodeURIComponent(name);
      const availA = await call('GET', `/agent-skills/available?q=${q}`, 'a');
      assert.equal(availA.status, 200);
      const availABody = await availA.json() as { items: Array<{ id: string }>; total: number };
      assert.ok(
        availABody.items.some((i) => i.id === skillId),
        `A available skillId=${skillId} body=${JSON.stringify(availABody)}`,
      );

      const availB = await call('GET', `/agent-skills/available?q=${q}`, 'b');
      assert.equal(availB.status, 200);
      const availBBody = await availB.json() as { items: Array<{ id: string }> };
      assert.ok(availBBody.items.some((i) => i.id === skillId));

      // admin manage ≠ automatic use for private skill
      const availAdmin = await call('GET', `/agent-skills/available?q=${q}`, 'admin');
      assert.equal(availAdmin.status, 200);
      const availAdminBody = await availAdmin.json() as { items: Array<{ id: string }> };
      assert.equal(availAdminBody.items.some((i) => i.id === skillId), false);

      const detailA = await call('GET', `/agent-skills/${skillId}`, 'a');
      assert.equal(detailA.status, 200);
      const detailABody = await detailA.json() as {
        draft: { version: number } | null;
        canEdit: boolean;
        canPublish: boolean;
        canManage: boolean;
      };
      assert.ok(detailABody.draft);
      assert.equal(detailABody.canEdit, true);
      assert.equal(detailABody.canManage, true);

      // use-only cannot read manage detail / draft / history
      const detailB = await call('GET', `/agent-skills/${skillId}`, 'b');
      assert.equal(detailB.status, 403);

      const versionsB = await call('GET', `/agent-skills/${skillId}/versions`, 'b');
      assert.equal(versionsB.status, 403);

      const eventsB = await call('GET', `/agent-skills/${skillId}/events`, 'b');
      assert.equal(eventsB.status, 403);

      // admin can manage detail
      const detailAdmin = await call('GET', `/agent-skills/${skillId}`, 'admin');
      assert.equal(detailAdmin.status, 200);
      const detailAdminBody = await detailAdmin.json() as { canManage: boolean; draft: unknown };
      assert.equal(detailAdminBody.canManage, true);
      assert.ok(detailAdminBody.draft);

      // files: use-only current published only; history draft version blocked
      const filesPubB = await call(
        'GET',
        `/agent-skills/${skillId}/files?version=${published.version.version}`,
        'b',
      );
      assert.equal(filesPubB.status, 200);

      const filesDraftB = await call(
        'GET',
        `/agent-skills/${skillId}/files?version=${draft.version.version}`,
        'b',
      );
      assert.equal(filesDraftB.status, 404);

      const downloadB = await call(
        'GET',
        `/agent-skills/${skillId}/files/download?version=${published.version.version}&path=SKILL.md`,
        'b',
      );
      assert.equal(downloadB.status, 200);
      const cd = downloadB.headers.get('content-disposition') ?? '';
      assert.match(cd, /filename\*=UTF-8''/);

      const exportB = await call(
        'GET',
        `/agent-skills/${skillId}/export?version=${published.version.version}`,
        'b',
      );
      assert.equal(exportB.status, 200);

      const exportDraftB = await call(
        'GET',
        `/agent-skills/${skillId}/export?version=${draft.version.version}`,
        'b',
      );
      assert.equal(exportDraftB.status, 404);

      // publish denied for use-only
      const publishB = await call('POST', `/agent-skills/${skillId}/publish`, 'b', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: draft.skill.revision,
          version: draft.version.version,
        }),
      });
      assert.equal(publishB.status, 403);

      // audiences: admin only
      assert.equal((await call('GET', '/agent-skills/audiences', 'a')).status, 403);
      assert.equal((await call('GET', '/agent-skills/audiences', 'b')).status, 403);
      const audiences = await call('GET', '/agent-skills/audiences', 'admin');
      assert.equal(audiences.status, 200);

      // groups GET ok for authenticated; POST admin only
      assert.equal((await call('GET', '/agent-skills/groups', 'a')).status, 200);
      const createGroup = await call('POST', '/agent-skills/groups', 'a', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `g-${suffix}` }),
      });
      assert.equal(createGroup.status, 403);
      const createGroupAdmin = await call('POST', '/agent-skills/groups', 'admin', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `g-${suffix}` }),
      });
      assert.equal(createGroupAdmin.status, 201);

      // static route not swallowed
      const notId = await call('GET', '/agent-skills/available', 'a');
      assert.equal(notId.status, 200);

      // users picker: admin or skill owner only; min fields
      assert.equal((await call('GET', '/agent-skills/users?q=SkillA', 'b')).status, 403);
      const users = await call('GET', `/agent-skills/users?q=SkillA`, 'a');
      assert.equal(users.status, 200);
      const usersBody = await users.json() as { items: Array<Record<string, unknown>> };
      assert.ok(usersBody.items.length >= 1);
      for (const item of usersBody.items) {
        assert.equal(Object.keys(item).sort().join(','), 'displayName,id');
      }
    } finally {
      await pool.query('DELETE FROM app_skill_events WHERE skill_id = $1', [skillId]).catch(() => undefined);
      await pool.query('DELETE FROM app_skill_files WHERE skill_id = $1', [skillId]).catch(() => undefined);
      await pool.query('DELETE FROM app_skill_versions WHERE skill_id = $1', [skillId]).catch(() => undefined);
      await pool.query('DELETE FROM app_skill_grants WHERE skill_id = $1', [skillId]).catch(() => undefined);
      await pool.query('DELETE FROM app_skill_audience_grants WHERE skill_id = $1', [skillId]).catch(() => undefined);
      await pool.query('DELETE FROM app_skill_aliases WHERE skill_id = $1', [skillId]).catch(() => undefined);
      await pool.query('DELETE FROM app_skills WHERE id = $1', [skillId]).catch(() => undefined);
      await pool.query(`DELETE FROM app_skill_groups WHERE name = $1`, [`g-${suffix}`]).catch(() => undefined);
      await pool.query('DELETE FROM app_sessions WHERE user_id = ANY($1::uuid[])', [[userA.id, userB.id, admin.id]])
        .catch(() => undefined);
      await pool.query('DELETE FROM app_user_roles WHERE user_id = ANY($1::uuid[])', [[userA.id, userB.id, admin.id]])
        .catch(() => undefined);
      await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [[userA.id, userB.id, admin.id]])
        .catch(() => undefined);
      await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
      if (prev === undefined) delete process.env.AGENT_SKILLS_ENABLED;
      else process.env.AGENT_SKILLS_ENABLED = prev;
    }
  },
);
