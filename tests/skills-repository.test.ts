import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { getPool } from '../src/mastra/auth/db.ts';
import { createUser } from '../src/mastra/auth/service.ts';
import { SkillRepositoryError } from '../src/mastra/skills/errors.ts';
import {
  createSkillRepository,
  SKILL_NAME_NAMESPACE_LOCK,
} from '../src/mastra/skills/repository.ts';
import type { CreateSkillDraftInput, SkillActor } from '../src/mastra/skills/types.ts';

/**
 * Safe local test DB only: loopback + port 5433 + db nero_agent (db:local:setup).
 * Never run destructive/integration assertions against unverified production URLs.
 */
function resolveSafeTestDatabaseUrl(): { ok: true; url: string } | { ok: false; reason: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL unset; skills repository DB tests skipped' };
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
          + '(expected 127.0.0.1|localhost:5433/nero_agent); refusing skills repository DB tests',
      };
    }
    return { ok: true, url: raw };
  } catch {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL is not a valid URL' };
  }
}

const safeDb = resolveSafeTestDatabaseUrl();
const hasSafeDatabase = safeDb.ok;

test('skills repository env gate documents BLOCKED_ENV when DB is unsafe or missing', () => {
  if (hasSafeDatabase) {
    assert.equal(safeDb.ok, true);
    return;
  }
  assert.match(safeDb.reason, /^BLOCKED_ENV:/);
  console.log(safeDb.reason);
});

const SKILL_MD = `---
name: demo-skill
description: Demo skill for repository tests
---

# Demo
`;

function draftInput(name: string, ownerUserId: string, overrides: Partial<CreateSkillDraftInput> = {}): CreateSkillDraftInput {
  return {
    ownerUserId,
    canonicalName: name,
    description: `Description for ${name}`,
    skillMd: SKILL_MD.replace('demo-skill', name),
    ...overrides,
  };
}

function actor(userId: string, roles: SkillActor['roles'] = ['user']): SkillActor {
  return { userId, roles };
}

async function publishVersion(
  skillId: string,
  version: number,
  publisherUserId: string,
  options: { enable?: boolean; visibility?: 'private' | 'global' | 'restricted' } = {},
): Promise<void> {
  const pool = getPool();
  await pool.query('BEGIN');
  try {
    await pool.query(
      `UPDATE app_skill_versions
       SET state = 'published', published_by = $3, published_at = now(),
           published_remark = 'test', manifest_hash = 'hash-' || $2::text, updated_at = now()
       WHERE skill_id = $1 AND version = $2 AND state = 'draft'`,
      [skillId, version, publisherUserId],
    );
    await pool.query(
      `UPDATE app_skills
       SET published_version = $2,
           enabled = COALESCE($3, enabled),
           visibility = COALESCE($4, visibility),
           revision = revision + 1,
           updated_at = now()
       WHERE id = $1`,
      [skillId, version, options.enable ?? null, options.visibility ?? null],
    );
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

test(
  'skills repository enforces FKs, name namespace, draft uniqueness, CAS, and list filters',
  { skip: !hasSafeDatabase },
  async () => {
    assert.ok(hasSafeDatabase, safeDb.ok ? 'ok' : safeDb.reason);
    const pool = getPool();
    const repo = createSkillRepository(pool);
    const suffix = randomUUID().slice(0, 8);
    const password = 'correct horse battery staple';
    const userIds: string[] = [];
    const skillIds: string[] = [];
    const groupIds: string[] = [];
    const audienceIds: string[] = [];

    try {
      const owner = await createUser({
        email: `skill-owner-${suffix}@example.test`,
        displayName: 'Skill Owner',
        password,
        role: 'user',
      });
      userIds.push(owner.id);
      const other = await createUser({
        email: `skill-other-${suffix}@example.test`,
        displayName: 'Skill Other',
        password,
        role: 'user',
      });
      userIds.push(other.id);
      const admin = await createUser({
        email: `skill-admin-${suffix}@example.test`,
        displayName: 'Skill Admin',
        password,
        role: 'admin',
      });
      userIds.push(admin.id);

      // UUID FK: invalid owner rejected
      await assert.rejects(
        () => repo.createDraft(draftInput(`fk-miss-${suffix}`, randomUUID())),
        (error: unknown) => {
          assert.ok(error && typeof error === 'object' && 'code' in error);
          return true;
        },
      );

      const group = await pool.query<{ id: string }>(
        `INSERT INTO app_skill_groups (name, sort) VALUES ($1, 10) RETURNING id`,
        [`group-${suffix}`],
      );
      groupIds.push(group.rows[0]!.id);
      const audience = await pool.query<{ id: string }>(
        `INSERT INTO app_skill_audiences (name) VALUES ($1) RETURNING id`,
        [`audience-${suffix}`],
      );
      audienceIds.push(audience.rows[0]!.id);
      assert.notEqual(group.rows[0]!.id, audience.rows[0]!.id);

      const created = await repo.createDraft(
        draftInput(`alpha-${suffix}`, owner.id, {
          alias: `Alpha.Alias_${suffix}`,
          groupId: group.rows[0]!.id,
          files: [
            {
              path: 'references/a.md',
              blobHash: 'a'.repeat(64),
              size: 12,
              isText: true,
              mimeType: 'text/markdown',
            },
          ],
        }),
      );
      skillIds.push(created.skill.id);
      assert.equal(created.skill.revision, '1');
      assert.equal(typeof created.skill.revision, 'string');
      assert.equal(created.skill.enabled, false);
      assert.equal(created.skill.visibility, 'private');
      assert.equal(created.version.version, 1);
      assert.equal(created.version.state, 'draft');

      const events = await pool.query(
        `SELECT event FROM app_skill_events WHERE skill_id = $1 ORDER BY created_at`,
        [created.skill.id],
      );
      assert.equal(events.rows[0]?.event, 'create');

      // Cross-table name conflict: alias equals another's canonical
      await assert.rejects(
        () =>
          repo.createDraft(
            draftInput(`beta-${suffix}`, owner.id, { alias: `alpha-${suffix}` }),
          ),
        (error: unknown) => {
          assert.ok(error instanceof SkillRepositoryError);
          assert.equal(error.code, 'NAME_CONFLICT');
          return true;
        },
      );

      // Cross-table: canonical equals existing alias
      const aliasHolder = await repo.createDraft(
        draftInput(`gamma-${suffix}`, owner.id, { alias: `shared-${suffix}` }),
      );
      skillIds.push(aliasHolder.skill.id);
      await assert.rejects(
        () => repo.createDraft(draftInput(`shared-${suffix}`, owner.id)),
        (error: unknown) => {
          assert.ok(error instanceof SkillRepositoryError);
          assert.equal(error.code, 'NAME_CONFLICT');
          return true;
        },
      );

      // Duplicate resource path rejected at insert
      await assert.rejects(
        () =>
          repo.createDraft(
            draftInput(`dup-path-${suffix}`, owner.id, {
              files: [
                { path: 'scripts/run.py', blobHash: 'b'.repeat(64), size: 1, isText: true },
                { path: 'scripts/run.py', blobHash: 'c'.repeat(64), size: 2, isText: true },
              ],
            }),
          ),
        (error: unknown) => {
          assert.ok(error instanceof SkillRepositoryError);
          assert.equal(error.code, 'INVALID_INPUT');
          return true;
        },
      );

      // One draft per skill (partial unique index)
      await publishVersion(created.skill.id, 1, owner.id, { enable: true, visibility: 'private' });
      const refreshed = await repo.getSkill(created.skill.id);
      assert.ok(refreshed);
      assert.equal(refreshed.publishedVersion, 1);

      const working = await repo.createWorkingDraft({
        skillId: created.skill.id,
        expectedRevision: refreshed.revision,
        actorUserId: owner.id,
        description: 'v2 draft',
        skillMd: SKILL_MD,
        files: [{ path: 'assets/data.json', blobHash: 'd'.repeat(64), size: 2, isText: true }],
      });
      assert.equal(working.version.version, 2);
      assert.equal(working.version.state, 'draft');

      await assert.rejects(
        () =>
          repo.createWorkingDraft({
            skillId: created.skill.id,
            expectedRevision: working.skill.revision,
            actorUserId: owner.id,
            description: 'another',
            skillMd: SKILL_MD,
          }),
        (error: unknown) => {
          assert.ok(error instanceof SkillRepositoryError);
          assert.equal(error.code, 'DRAFT_EXISTS');
          return true;
        },
      );

      // Version numbers do not reuse deleted versions (version_seq high-water mark)
      await pool.query(
        `DELETE FROM app_skill_versions WHERE skill_id = $1 AND version = 2`,
        [created.skill.id],
      );
      const maxRemaining = await pool.query<{ max: string | null }>(
        `SELECT MAX(version)::text AS max FROM app_skill_versions WHERE skill_id = $1`,
        [created.skill.id],
      );
      assert.equal(Number(maxRemaining.rows[0]?.max ?? 0), 1);
      const seqAfterDelete = await pool.query<{ version_seq: number }>(
        `SELECT version_seq FROM app_skills WHERE id = $1`,
        [created.skill.id],
      );
      assert.equal(Number(seqAfterDelete.rows[0]?.version_seq), 2);
      const afterDelete = await repo.getSkill(created.skill.id);
      assert.ok(afterDelete);
      const v3 = await repo.createWorkingDraft({
        skillId: created.skill.id,
        expectedRevision: afterDelete.revision,
        actorUserId: owner.id,
        description: 'v3 draft',
        skillMd: SKILL_MD,
      });
      assert.equal(v3.version.version, 3);

      // Path uniqueness at DB for same version
      await assert.rejects(async () => {
        await pool.query(
          `INSERT INTO app_skill_files (skill_id, version, path, blob_hash, size, is_text)
           VALUES ($1, 3, 'assets/data.json', $2, 1, true)`,
          [created.skill.id, 'e'.repeat(64)],
        );
        await pool.query(
          `INSERT INTO app_skill_files (skill_id, version, path, blob_hash, size, is_text)
           VALUES ($1, 3, 'assets/data.json', $2, 1, true)`,
          [created.skill.id, 'f'.repeat(64)],
        );
      });

      // Concurrent CAS: only one updateDraft succeeds
      const beforeCas = await repo.getSkill(created.skill.id);
      assert.ok(beforeCas);
      const expected = beforeCas.revision;
      const results = await Promise.allSettled([
        repo.updateDraft({
          skillId: created.skill.id,
          expectedRevision: expected,
          actorUserId: owner.id,
          skillMd: `${SKILL_MD}\nA`,
        }),
        repo.updateDraft({
          skillId: created.skill.id,
          expectedRevision: expected,
          actorUserId: owner.id,
          skillMd: `${SKILL_MD}\nB`,
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0] && rejected[0].status === 'rejected');
      assert.ok(rejected[0].reason instanceof SkillRepositoryError);
      assert.equal(rejected[0].reason.code, 'REVISION_CONFLICT');

      // transaction(fn) uses the same client (advisory lock visible inside callback)
      await repo.transaction(async (tx) => {
        const clientCheck = await tx.getSkill(created.skill.id);
        assert.ok(clientCheck);
        // Nested write on same connection
        const bumped = await tx.updateMetadata({
          skillId: created.skill.id,
          expectedRevision: clientCheck.revision,
          actorUserId: owner.id,
          visibility: 'restricted',
        });
        assert.equal(bumped.visibility, 'restricted');
        assert.notEqual(bumped.revision, clientCheck.revision);
      });

      // Soft-delete filtered from get/list
      const softTarget = await repo.createDraft(draftInput(`soft-${suffix}`, owner.id));
      skillIds.push(softTarget.skill.id);
      await repo.updateMetadata({
        skillId: softTarget.skill.id,
        expectedRevision: softTarget.skill.revision,
        actorUserId: owner.id,
        deleted: true,
      });
      assert.equal(await repo.getSkill(softTarget.skill.id), null);
      const manageable = await repo.listManageable(actor(owner.id), {
        page: 1,
        pageSize: 50,
        q: suffix,
      });
      assert.ok(!manageable.items.some((item) => item.id === softTarget.skill.id));

      // listAvailable: owner private enabled; other needs grant/audience; admin manage ≠ use
      await publishVersion(created.skill.id, 3, owner.id, { enable: true });
      const enabled = await repo.getSkill(created.skill.id);
      assert.ok(enabled?.enabled);

      const ownerAvailable = await repo.listAvailable(actor(owner.id), {
        page: 1,
        pageSize: 50,
        q: `alpha-${suffix}`,
      });
      assert.ok(ownerAvailable.items.some((item) => item.id === created.skill.id));

      const otherAvailableBefore = await repo.listAvailable(actor(other.id), {
        page: 1,
        pageSize: 50,
        q: `alpha-${suffix}`,
      });
      assert.ok(!otherAvailableBefore.items.some((item) => item.id === created.skill.id));

      await pool.query(
        `INSERT INTO app_skill_grants (skill_id, user_id, permission) VALUES ($1, $2, 'use')`,
        [created.skill.id, other.id],
      );
      const otherAvailableAfter = await repo.listAvailable(actor(other.id), {
        page: 1,
        pageSize: 50,
        q: `alpha-${suffix}`,
      });
      assert.ok(otherAvailableAfter.items.some((item) => item.id === created.skill.id));

      const adminManage = await repo.listManageable(actor(admin.id, ['admin']), {
        page: 1,
        pageSize: 50,
        q: `alpha-${suffix}`,
      });
      assert.ok(adminManage.items.some((item) => item.id === created.skill.id));

      // Admin does not automatically appear in available without use grant / ownership / global
      await pool.query(`DELETE FROM app_skill_grants WHERE skill_id = $1 AND user_id = $2`, [
        created.skill.id,
        other.id,
      ]);
      await pool.query(
        `UPDATE app_skills SET visibility = 'private' WHERE id = $1`,
        [created.skill.id],
      );
      const adminAvailable = await repo.listAvailable(actor(admin.id, ['admin']), {
        page: 1,
        pageSize: 50,
        q: `alpha-${suffix}`,
      });
      assert.ok(!adminAvailable.items.some((item) => item.id === created.skill.id));

      // Audience grant path (distinct from content group)
      await pool.query(
        `INSERT INTO app_skill_audience_members (audience_id, user_id) VALUES ($1, $2)`,
        [audience.rows[0]!.id, other.id],
      );
      await pool.query(
        `INSERT INTO app_skill_audience_grants (skill_id, audience_id) VALUES ($1, $2)`,
        [created.skill.id, audience.rows[0]!.id],
      );
      const viaAudience = await repo.listAvailable(actor(other.id), {
        page: 1,
        pageSize: 50,
        q: `alpha-${suffix}`,
      });
      assert.ok(viaAudience.items.some((item) => item.id === created.skill.id));

      // Namespace lock constant is the fixed advisory key
      assert.equal(SKILL_NAME_NAMESPACE_LOCK, 'app_skill_name_namespace');
    } finally {
      const p = getPool();
      if (skillIds.length) {
        await p.query('DELETE FROM app_skill_events WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query('DELETE FROM app_skill_audience_grants WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query('DELETE FROM app_skill_grants WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query('DELETE FROM app_skill_files WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query('DELETE FROM app_skill_aliases WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query(
          'UPDATE app_skills SET published_version = NULL WHERE id = ANY($1::uuid[])',
          [skillIds],
        );
        await p.query('DELETE FROM app_skill_versions WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query('DELETE FROM app_skills WHERE id = ANY($1::uuid[])', [skillIds]);
      }
      if (audienceIds.length) {
        await p.query('DELETE FROM app_skill_audience_members WHERE audience_id = ANY($1::uuid[])', [
          audienceIds,
        ]);
        await p.query('DELETE FROM app_skill_audiences WHERE id = ANY($1::uuid[])', [audienceIds]);
      }
      if (groupIds.length) {
        await p.query('DELETE FROM app_skill_groups WHERE id = ANY($1::uuid[])', [groupIds]);
      }
      if (userIds.length) {
        await p.query('DELETE FROM app_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
        await p.query('DELETE FROM app_user_roles WHERE user_id = ANY($1::uuid[])', [userIds]);
        await p.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [userIds]);
      }
    }
  },
);
