/**
 * Task 9: management APIs — enable/disable, version delete, groups, audiences, events.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getPool } from '../src/mastra/auth/db.ts';
import { createUser } from '../src/mastra/auth/service.ts';
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import { SkillRepositoryError } from '../src/mastra/skills/errors.ts';
import { SkillPolicyError } from '../src/mastra/skills/policy.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';
import { createSkillRepository } from '../src/mastra/skills/repository.ts';
import { createSkillService } from '../src/mastra/skills/service.ts';
import type { SkillActor, SkillExecutionContext } from '../src/mastra/skills/types.ts';
import { createSkillVersionService } from '../src/mastra/skills/versions.ts';

function resolveSafeTestDatabaseUrl(): { ok: true; url: string } | { ok: false; reason: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL unset; skills management DB tests skipped' };
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
          + '(expected 127.0.0.1|localhost:5433/nero_agent); refusing skills management DB tests',
      };
    }
    return { ok: true, url: raw };
  } catch {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL is not a valid URL' };
  }
}

const safeDb = resolveSafeTestDatabaseUrl();
const hasSafeDatabase = safeDb.ok;

function actor(userId: string, roles: SkillActor['roles'] = ['user']): SkillActor {
  return { userId, roles };
}

function execCtx(auth: SkillActor): SkillExecutionContext {
  return {
    serverExecutionId: randomUUID(),
    auth,
    threadId: randomUUID(),
    pins: new Map(),
  };
}

function skillMd(name: string, body = '# Body'): string {
  return `---
name: ${name}
description: Management test skill ${name}
---

${body}
`;
}

test('skills management env gate documents BLOCKED_ENV when DB is unsafe or missing', () => {
  if (hasSafeDatabase) {
    assert.equal(safeDb.ok, true);
    return;
  }
  assert.match(safeDb.reason, /^BLOCKED_ENV:/);
  console.log(safeDb.reason);
});

test(
  'management: enable unpublished fails; pin-protected delete; group empty; audience revoke; non-admin global; events page',
  { skip: !hasSafeDatabase },
  async () => {
    assert.ok(hasSafeDatabase, safeDb.ok ? 'ok' : safeDb.reason);
    const storageRoot = await mkdtemp(join(tmpdir(), 'skills-mgmt-'));
    const pool = getPool();
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

    const suffix = randomUUID().slice(0, 8);
    const password = 'correct horse battery staple';
    const userIds: string[] = [];
    const skillIds: string[] = [];
    const groupIds: string[] = [];
    const audienceIds: string[] = [];

    try {
      const owner = await createUser({
        email: `skill-mgmt-owner-${suffix}@example.test`,
        displayName: 'Mgmt Owner',
        password,
        role: 'user',
      });
      userIds.push(owner.id);
      const member = await createUser({
        email: `skill-mgmt-member-${suffix}@example.test`,
        displayName: 'Mgmt Member',
        password,
        role: 'user',
      });
      userIds.push(member.id);
      const admin = await createUser({
        email: `skill-mgmt-admin-${suffix}@example.test`,
        displayName: 'Mgmt Admin',
        password,
        role: 'admin',
      });
      userIds.push(admin.id);

      const name = `mgmt-${suffix}`;
      const created = await service.createDraft(actor(owner.id), {
        name,
        description: `Description for ${name}`,
        skillMd: skillMd(name),
      });
      skillIds.push(created.skill.id);
      assert.equal(created.skill.enabled, false);
      assert.equal(created.skill.publishedVersion, null);

      // enable unpublished fails
      await assert.rejects(
        () =>
          service.setEnabled(actor(owner.id), {
            skillId: created.skill.id,
            expectedRevision: created.skill.revision,
            enabled: true,
          }),
        (error: unknown) => {
          assert.ok(error instanceof SkillRepositoryError);
          assert.equal(error.code, 'INVALID_INPUT');
          assert.equal(error.status, 400);
          return true;
        },
      );
      const stillDraft = await repo.getSkill(created.skill.id);
      assert.equal(stillDraft?.enabled, false);
      assert.equal(stillDraft?.revision, created.skill.revision);

      const published = await service.publish(actor(owner.id), {
        skillId: created.skill.id,
        version: 1,
        expectedRevision: created.skill.revision,
      });
      assert.equal(published.skill.enabled, false);

      const enabled = await service.setEnabled(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: published.skill.revision,
        enabled: true,
      });
      assert.equal(enabled.enabled, true);
      assert.notEqual(enabled.revision, published.skill.revision);

      const enableEvents = await service.listEvents(actor(owner.id), {
        skillId: created.skill.id,
        page: 1,
        pageSize: 20,
      });
      assert.ok(enableEvents.items.some((e) => e.event === 'enable'));
      assert.ok(enableEvents.items.some((e) => e.event === 'publish'));

      // non-admin cannot set global
      await assert.rejects(
        () =>
          service.setMetadata(actor(owner.id), {
            skillId: created.skill.id,
            expectedRevision: enabled.revision,
            visibility: 'global',
          }),
        (error: unknown) => {
          assert.ok(error instanceof SkillPolicyError);
          assert.equal(error.code, 'FORBIDDEN');
          return true;
        },
      );
      const afterGlobalFail = await repo.getSkill(created.skill.id);
      assert.equal(afterGlobalFail?.visibility, 'private');
      assert.equal(afterGlobalFail?.revision, enabled.revision);

      // group create/move; delete group requires empty
      const groupA = await service.createGroup(actor(admin.id, ['admin']), {
        name: `grp-a-${suffix}`,
        sort: 1,
      });
      groupIds.push(groupA.id);
      const groupB = await service.createGroup(actor(admin.id, ['admin']), {
        name: `grp-b-${suffix}`,
        sort: 2,
      });
      groupIds.push(groupB.id);

      const moved = await service.setMetadata(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: enabled.revision,
        groupId: groupA.id,
      });
      assert.equal(moved.groupId, groupA.id);
      assert.notEqual(moved.revision, enabled.revision);

      const movedAgain = await service.setMetadata(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: moved.revision,
        groupId: groupB.id,
      });
      assert.equal(movedAgain.groupId, groupB.id);

      await assert.rejects(
        () => service.deleteGroup(actor(admin.id, ['admin']), groupB.id),
        (error: unknown) => {
          assert.ok(error instanceof SkillRepositoryError);
          assert.equal(error.code, 'INVALID_INPUT');
          assert.match(error.message, /Move skills out/i);
          return true;
        },
      );

      const cleared = await service.setMetadata(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: movedAgain.revision,
        groupId: null,
      });
      assert.equal(cleared.groupId, null);
      await service.deleteGroup(actor(admin.id, ['admin']), groupB.id);
      groupIds.splice(groupIds.indexOf(groupB.id), 1);

      // audience membership: grant use via audience → remove member → next read fails
      const audience = await service.createAudience(actor(admin.id, ['admin']), {
        name: `aud-${suffix}`,
        memberIds: [member.id],
      });
      audienceIds.push(audience.id);

      const withAudience = await service.setMetadata(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: cleared.revision,
        visibility: 'restricted',
        audienceIds: [audience.id],
      });
      assert.equal(withAudience.visibility, 'restricted');
      assert.ok(withAudience.revision !== cleared.revision);
      const grantEvents = await service.listEvents(actor(owner.id), {
        skillId: created.skill.id,
        page: 1,
        pageSize: 5,
      });
      assert.equal(grantEvents.items[0]?.event, 'grant');

      const memberCtx = execCtx(actor(member.id));
      const loaded = await service.load(memberCtx, name);
      assert.equal(loaded.ok, true);
      const readOk = await service.read(memberCtx, { skillName: name, path: 'SKILL.md' });
      assert.equal(readOk.ok, true);

      await service.updateAudience(actor(admin.id, ['admin']), {
        id: audience.id,
        memberIds: [],
      });
      const afterRemove = await service.read(memberCtx, { skillName: name, path: 'SKILL.md' });
      assert.equal(afterRemove.ok, false);
      if (!afterRemove.ok) assert.equal(afterRemove.code, 'SKILL_UNAVAILABLE');

      // working draft + pin-protected version delete
      const draft2 = await service.createWorkingDraft(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: withAudience.revision,
      });
      assert.equal(draft2.version.version, 2);
      assert.equal(draft2.version.state, 'draft');

      const pub2 = await service.publish(actor(owner.id), {
        skillId: created.skill.id,
        version: 2,
        expectedRevision: draft2.skill.revision,
      });
      assert.equal(pub2.skill.publishedVersion, 2);

      // cannot delete current publish pointer
      await assert.rejects(
        () =>
          service.deleteVersion(actor(owner.id), {
            skillId: created.skill.id,
            version: 2,
            expectedRevision: pub2.skill.revision,
          }),
        (error: unknown) => {
          assert.ok(error instanceof SkillRepositoryError);
          assert.equal(error.code, 'VERSION_IN_USE');
          return true;
        },
      );

      // rollback to v1 then pin v1 → delete v1 fails
      const rolled = await service.rollback(actor(owner.id), {
        skillId: created.skill.id,
        targetVersion: 1,
        expectedRevision: pub2.skill.revision,
      });
      assert.equal(rolled.skill.publishedVersion, 1);

      await repo.upsertRunPin({
        serverExecutionId: randomUUID(),
        userId: owner.id,
        threadId: randomUUID(),
        pin: {
          skillId: created.skill.id,
          name,
          version: 2,
          manifestHash: pub2.manifestHash,
        },
      });

      await assert.rejects(
        () =>
          service.deleteVersion(actor(owner.id), {
            skillId: created.skill.id,
            version: 2,
            expectedRevision: rolled.skill.revision,
          }),
        (error: unknown) => {
          assert.ok(error instanceof SkillRepositoryError);
          assert.equal(error.code, 'VERSION_IN_USE');
          return true;
        },
      );

      // expire pin then delete succeeds
      await pool.query(
        `UPDATE app_skill_run_pins SET expires_at = now() - interval '1 minute'
         WHERE skill_id = $1 AND version = 2`,
        [created.skill.id],
      );
      const deletedV2 = await service.deleteVersion(actor(owner.id), {
        skillId: created.skill.id,
        version: 2,
        expectedRevision: rolled.skill.revision,
      });
      assert.ok(deletedV2.revision !== rolled.skill.revision);
      assert.equal(await repo.getVersion(created.skill.id, 2), null);

      // events pagination
      const page1 = await service.listEvents(actor(owner.id), {
        skillId: created.skill.id,
        page: 1,
        pageSize: 2,
      });
      assert.equal(page1.pageSize, 2);
      assert.equal(page1.items.length, 2);
      assert.ok(page1.total > 2);
      const page2 = await service.listEvents(actor(owner.id), {
        skillId: created.skill.id,
        page: 2,
        pageSize: 2,
      });
      assert.equal(page2.items.length, 2);
      assert.notEqual(page1.items[0]!.id, page2.items[0]!.id);

      const disabled = await service.setEnabled(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: deletedV2.revision,
        enabled: false,
      });
      assert.equal(disabled.enabled, false);
      const disableEvents = await service.listEvents(actor(owner.id), {
        skillId: created.skill.id,
        page: 1,
        pageSize: 3,
      });
      assert.equal(disableEvents.items[0]?.event, 'disable');
    } finally {
      const p = getPool();
      if (skillIds.length) {
        await p.query('DELETE FROM app_skill_run_pins WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query('DELETE FROM app_skill_events WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query('DELETE FROM app_skill_audience_grants WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query('DELETE FROM app_skill_grants WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query('DELETE FROM app_skill_files WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query('DELETE FROM app_skill_aliases WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query(
          'UPDATE app_skills SET published_version = NULL, group_id = NULL WHERE id = ANY($1::uuid[])',
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
        await p.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [userIds]);
      }
      await rm(storageRoot, { recursive: true, force: true });
    }
  },
);
