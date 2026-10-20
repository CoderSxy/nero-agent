/**
 * Task 13: shortcut fields, literal prompts, and use-permission filtering.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import { getPool } from '../src/mastra/auth/db.ts';
import { createUser } from '../src/mastra/auth/service.ts';
import type { AuthUser } from '../src/mastra/auth/service.ts';
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import { SkillPolicyError } from '../src/mastra/skills/policy.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';
import { createSkillRepository } from '../src/mastra/skills/repository.ts';
import { createSkillRoutes } from '../src/mastra/skills/routes.ts';
import { createSkillService } from '../src/mastra/skills/service.ts';
import {
  renderShortcutPrompt,
  SkillShortcutError,
  validateShortcut,
  validateShortcutValues,
  type ShortcutField,
} from '../src/mastra/skills/shortcuts.ts';
import type { SkillActor } from '../src/mastra/skills/types.ts';
import { createSkillVersionService } from '../src/mastra/skills/versions.ts';

const g = globalThis as typeof globalThis & { __shortcutPwned?: number; __shortcutRan?: number };

function field(partial: Partial<ShortcutField> & Pick<ShortcutField, 'key' | 'type'>): ShortcutField {
  return { label: partial.label ?? partial.key, required: partial.required ?? false, ...partial };
}

const fiveFields = [
  field({ key: 'topic', type: 'text', required: true }),
  field({ key: 'detail', type: 'textarea' }),
  field({ key: 'level', type: 'select', options: ['low', 'high'], required: true }),
  field({ key: 'count', type: 'number', min: 1, max: 10, required: true }),
  field({ key: 'confirm', type: 'boolean' }),
];

test('shortcut validation accepts five controls and rejects limits, keys, and unknown fields', () => {
  const prompts = Array.from({ length: 20 }, (_, index) => ({
    label: `选项${index + 1}`,
    template: '处理 {{f0}}',
  }));
  const fields = Array.from({ length: 10 }, (_, index) => field({
    key: `f${index}`,
    type: 'text' as const,
  }));
  const ok = validateShortcut({
    label: '清单',
    enabled: true,
    sort: 1,
    fields: fiveFields,
    prompts: [{ label: '开始', template: '请处理 {{topic}} {{detail}} {{level}} {{count}} {{confirm}}' }],
  });
  assert.equal(ok.fields.length, 5);
  assert.deepEqual(ok.fields.map((item) => item.type), ['text', 'textarea', 'select', 'number', 'boolean']);
  assert.equal(validateShortcut({ label: 'x', enabled: false, sort: 0, fields, prompts }).prompts.length, 20);

  assert.throws(() => validateShortcut({
    label: 'x', enabled: true, sort: 0, fields: [...fields, field({ key: 'extra', type: 'text' })], prompts: [],
  }), (error: unknown) => error instanceof SkillShortcutError && /10/.test(error.message));
  assert.throws(() => validateShortcut({
    label: 'x', enabled: true, sort: 0, fields: [], prompts: [...prompts, { label: '更多', template: 'x' }],
  }), (error: unknown) => error instanceof SkillShortcutError && /20/.test(error.message));
  assert.throws(() => validateShortcut({
    label: 'x'.repeat(81), enabled: true, sort: 0, fields: [], prompts: [],
  }), (error: unknown) => error instanceof SkillShortcutError);
  assert.throws(() => validateShortcut({
    label: 'x', enabled: true, sort: 0,
    fields: [field({ key: 'a'.repeat(33), type: 'text' })],
    prompts: [],
  }), (error: unknown) => error instanceof SkillShortcutError && /key/.test(error.message));
  assert.throws(() => validateShortcut({
    label: 'x', enabled: true, sort: 0, fields: [], prompts: [], script: 'alert(1)',
  }), (error: unknown) => error instanceof SkillShortcutError && /未知字段/.test(error.message));
  assert.throws(() => validateShortcut({
    label: 'x', enabled: true, sort: 0,
    fields: [field({ key: 'topic', type: 'text' })],
    prompts: [{ label: '坏', template: '跑 {{missing}}' }],
  }), (error: unknown) => error instanceof SkillShortcutError && /未知字段/.test(error.message));
});

test('shortcut values enforce required, numeric range, and select enums', () => {
  assert.throws(() => validateShortcutValues(fiveFields, { detail: 'x' }), /必填/);
  assert.throws(() => validateShortcutValues(fiveFields, {
    topic: '发票', detail: '', level: 'nope', count: 3, confirm: false,
  }), /可选项/);
  assert.throws(() => validateShortcutValues(fiveFields, {
    topic: '发票', detail: '', level: 'low', count: 0, confirm: false,
  }), /下限/);
  assert.throws(() => validateShortcutValues(fiveFields, {
    topic: '发票', detail: '', level: 'low', count: 11, confirm: false,
  }), /上限/);
  assert.throws(() => validateShortcutValues(fiveFields, {
    topic: '发票', detail: '', level: 'low', count: 2, confirm: false, injected: '1',
  }), /未知字段/);
  const values = validateShortcutValues(fiveFields, {
    topic: '发票', detail: '补充', level: 'high', count: '4', confirm: true,
  });
  assert.equal(values.count, '4');
  assert.equal(values.confirm, 'true');
});

test('{{field}} inserts strings and does not execute templates, HTML, or functions', () => {
  delete g.__shortcutPwned;
  delete g.__shortcutRan;
  const template = '值={{topic}} 嵌套={{note}} ${globalThis.__shortcutPwned = 1} <script>alert(1)</script>';
  const text = renderShortcutPrompt(template, {
    topic: 'function(){ globalThis.__shortcutRan = 1 }',
    note: '{{topic}}',
  });
  assert.equal(text.includes('function(){ globalThis.__shortcutRan = 1 }'), true);
  assert.equal(text.includes('{{topic}}'), true);
  assert.equal(text.includes('${globalThis.__shortcutPwned = 1}'), true);
  assert.equal(text.includes('<script>alert(1)</script>'), true);
  assert.equal(g.__shortcutPwned, undefined);
  assert.equal(g.__shortcutRan, undefined);
  assert.equal(renderShortcutPrompt('保持 {{missing}}', { missing: 1 as unknown as string }), '保持 {{missing}}');
});

const USER_A = '11111111-1111-4111-8111-111111111111';
const SKILL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function buildApp(routes: ApiRoute[], resolveUser: (token: string) => AuthUser | null) {
  const app = new Hono();
  for (const route of routes) {
    if (!('handler' in route) || !route.handler) throw new Error(`route ${route.path} has no handler`);
    const handler = route.handler;
    app.on(route.method, route.path, async (c) => {
      const requestContext = new RequestContext();
      c.set('requestContext', requestContext);
      const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? '';
      const authed = resolveUser(token);
      if (!authed) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Unauthorized' } }, 401);
      requestContext.set('mastra__user', authed);
      requestContext.set('user', { id: USER_A, roles: ['admin'] });
      return handler(c);
    });
  }
  return app;
}

test('shortcut HTTP rejects unknown fields and uses the authenticated actor', async () => {
  const prev = process.env.AGENT_SKILLS_ENABLED;
  process.env.AGENT_SKILLS_ENABLED = 'true';
  const seen: string[] = [];
  try {
    const routes = createSkillRoutes(() => ({
      listAvailableShortcuts: async (actor: SkillActor) => {
        seen.push(actor.userId);
        return { items: [] };
      },
      putShortcut: async () => {
        throw new Error('invalid shortcut must not be stored');
      },
    }) as never);
    const app = buildApp(routes, (token) => token === 'user' ? {
      id: USER_A, email: 'a@example.test', displayName: 'A', roles: ['user'],
    } : null);
    const available = await app.request('/agent-skills/shortcuts/available', {
      headers: { authorization: 'Bearer user' },
    });
    assert.equal(available.status, 200);
    assert.deepEqual(seen, [USER_A]);
    const rejected = await app.request(`/agent-skills/${SKILL_A}/shortcut`, {
      method: 'PUT',
      headers: { authorization: 'Bearer user', 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: '0',
        label: 'x',
        enabled: true,
        sort: 0,
        fields: [],
        prompts: [],
        script: 'process.exit(1)',
      }),
    });
    assert.equal(rejected.status, 400);
    const body = await rejected.json() as { error: { code: string } };
    assert.equal(body.error.code, 'INVALID_INPUT');
  } finally {
    if (prev === undefined) delete process.env.AGENT_SKILLS_ENABLED;
    else process.env.AGENT_SKILLS_ENABLED = prev;
  }
});

function resolveSafeTestDatabaseUrl(): { ok: true; url: string } | { ok: false; reason: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL unset; shortcut DB tests skipped' };
  try {
    const parsed = new URL(raw);
    const hostOk = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    const portOk = parsed.port === '5433';
    const dbOk = parsed.pathname.replace(/^\//, '') === 'nero_agent';
    if (!hostOk || !portOk || !dbOk) {
      return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL is not 127.0.0.1:5433/nero_agent' };
    }
    return { ok: true, url: raw };
  } catch {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL is not a valid URL' };
  }
}

const safeDb = resolveSafeTestDatabaseUrl();

test('shortcut DB gate documents BLOCKED_ENV when the database is unavailable', () => {
  if (safeDb.ok) {
    assert.equal(safeDb.ok, true);
    return;
  }
  assert.match(safeDb.reason, /^BLOCKED_ENV:/);
  console.log(safeDb.reason);
});

function actor(userId: string, roles: SkillActor['roles'] = ['user']): SkillActor {
  return { userId, roles };
}

test('shortcut access follows skill id, use permission, and enablement', { skip: !safeDb.ok }, async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'skills-shortcut-'));
  const pool = getPool();
  const repo = createSkillRepository(pool);
  const blobStore = createBlobStore({ root: storageRoot });
  const releaseStore = createReleaseStore({ root: storageRoot, blobStore });
  const versions = createSkillVersionService({ repository: repo, blobStore, releaseStore, pool });
  const service = createSkillService({ repository: repo, blobStore, releaseStore, versionService: versions, pool });
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const skillIds: string[] = [];
  const config = {
    label: '清单入口',
    enabled: true,
    sort: 2,
    fields: [field({ key: 'topic', type: 'text' as const, required: true })],
    prompts: [{ label: '开始', template: '请按 reference-demo 清单处理 {{topic}}' }],
  };
  try {
    const owner = await createUser({
      email: `shortcut-owner-${suffix}@example.test`, displayName: 'Owner', password: 'correct horse battery staple', role: 'user',
    });
    const editor = await createUser({
      email: `shortcut-editor-${suffix}@example.test`, displayName: 'Editor', password: 'correct horse battery staple', role: 'user',
    });
    const reader = await createUser({
      email: `shortcut-reader-${suffix}@example.test`, displayName: 'Reader', password: 'correct horse battery staple', role: 'user',
    });
    const admin = await createUser({
      email: `shortcut-admin-${suffix}@example.test`, displayName: 'Admin', password: 'correct horse battery staple', role: 'admin',
    });
    userIds.push(owner.id, editor.id, reader.id, admin.id);
    const created = await repo.createDraft({
      ownerUserId: owner.id,
      canonicalName: `ref-${suffix}`,
      alias: `alias-${suffix}`,
      description: 'shortcut fixture',
      skillMd: '---\nname: ref\ndescription: shortcut\n---\n\n# Body\n',
      actorUserId: owner.id,
    });
    skillIds.push(created.skill.id);
    await pool.query(
      `UPDATE app_skill_versions SET state = 'published', manifest_hash = $3, published_at = now(), published_by = $2
       WHERE skill_id = $1 AND version = 1`,
      [created.skill.id, owner.id, 'a'.repeat(64)],
    );
    await pool.query(
      `UPDATE app_skills SET published_version = 1, enabled = true, revision = revision + 1 WHERE id = $1`,
      [created.skill.id],
    );

    const saved = await service.putShortcut(actor(owner.id), {
      skillId: created.skill.id, expectedRevision: '0', config,
    });
    assert.equal(saved.shortcut.skillId, created.skill.id);
    assert.equal(saved.shortcut.revision, '1');

    await assert.rejects(
      () => service.putShortcut(actor(editor.id), {
        skillId: created.skill.id, expectedRevision: '1', config,
      }),
      (error: unknown) => error instanceof SkillPolicyError && error.code === 'FORBIDDEN',
    );
    await pool.query(
      `INSERT INTO app_skill_grants (skill_id, user_id, permission) VALUES ($1, $2, 'edit')`,
      [created.skill.id, editor.id],
    );
    await assert.rejects(
      () => service.putShortcut(actor(editor.id), {
        skillId: created.skill.id, expectedRevision: '1', config,
      }),
      (error: unknown) => error instanceof SkillPolicyError && error.code === 'FORBIDDEN',
    );
    const afterEdit = await service.getShortcut(actor(owner.id), created.skill.id);
    assert.equal(afterEdit.shortcut?.revision, '1');

    const adminSaved = await service.putShortcut(actor(admin.id, ['admin']), {
      skillId: created.skill.id, expectedRevision: '1', config,
    });
    const adminAvailable = await service.listAvailableShortcuts(actor(admin.id, ['admin']));
    const adminSkills = await service.listAvailable(actor(admin.id, ['admin']), { page: 1, pageSize: 20 });
    assert.equal(adminAvailable.items.some((item) => item.skillId === created.skill.id), false);
    assert.equal(adminSkills.items.some((item) => item.id === created.skill.id), false);
    assert.equal(adminSaved.shortcut.skillId, created.skill.id);

    await pool.query(
      `INSERT INTO app_skill_grants (skill_id, user_id, permission) VALUES ($1, $2, 'use')`,
      [created.skill.id, reader.id],
    );
    const granted = await service.listAvailableShortcuts(actor(reader.id));
    assert.equal(granted.items[0]?.skillId, created.skill.id);
    assert.equal(granted.items[0]?.skillName, `ref-${suffix}`);
    await pool.query(`UPDATE app_skill_aliases SET alias = $2 WHERE skill_id = $1`, [created.skill.id, `renamed-${suffix}`]);
    const renamed = await service.listAvailableShortcuts(actor(reader.id));
    assert.equal(renamed.items[0]?.skillId, created.skill.id);
    assert.equal(renamed.items[0]?.skillName, `ref-${suffix}`);

    await pool.query(`DELETE FROM app_skill_grants WHERE skill_id = $1 AND user_id = $2 AND permission = 'use'`, [
      created.skill.id, reader.id,
    ]);
    const revoked = await service.listAvailableShortcuts(actor(reader.id));
    assert.equal(revoked.items.length, 0);
    const ownerStill = await service.listAvailableShortcuts(actor(owner.id));
    assert.equal(ownerStill.items[0]?.skillId, created.skill.id);

    await pool.query(`UPDATE app_skills SET enabled = false WHERE id = $1`, [created.skill.id]);
    const disabledSkill = await service.listAvailableShortcuts(actor(owner.id));
    assert.equal(disabledSkill.items.length, 0);
    await pool.query(`UPDATE app_skills SET enabled = true WHERE id = $1`, [created.skill.id]);
    await service.putShortcut(actor(owner.id), {
      skillId: created.skill.id,
      expectedRevision: adminSaved.shortcut.revision,
      config: { ...config, enabled: false },
    });
    const disabledEntry = await service.listAvailableShortcuts(actor(owner.id));
    assert.equal(disabledEntry.items.length, 0);
  } finally {
    if (skillIds.length) {
      await pool.query('DELETE FROM app_skill_shortcuts WHERE skill_id = ANY($1::uuid[])', [skillIds]);
      await pool.query('DELETE FROM app_skill_events WHERE skill_id = ANY($1::uuid[])', [skillIds]);
      await pool.query('DELETE FROM app_skill_grants WHERE skill_id = ANY($1::uuid[])', [skillIds]);
      await pool.query('DELETE FROM app_skill_aliases WHERE skill_id = ANY($1::uuid[])', [skillIds]);
      await pool.query('UPDATE app_skills SET published_version = NULL WHERE id = ANY($1::uuid[])', [skillIds]);
      await pool.query('DELETE FROM app_skill_versions WHERE skill_id = ANY($1::uuid[])', [skillIds]);
      await pool.query('DELETE FROM app_skills WHERE id = ANY($1::uuid[])', [skillIds]);
    }
    if (userIds.length) {
      await pool.query('DELETE FROM app_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await rm(storageRoot, { recursive: true, force: true });
  }
});
