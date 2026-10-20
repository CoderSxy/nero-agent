/**
 * Task 5: persistent app_skill_run_pins bound to userId/threadId/serverExecutionId.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { getPool } from '../src/mastra/auth/db.ts';
import { createUser } from '../src/mastra/auth/service.ts';
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';
import { createSkillRepository } from '../src/mastra/skills/repository.ts';
import { createSkillService } from '../src/mastra/skills/service.ts';
import type { SkillActor, SkillExecutionContext } from '../src/mastra/skills/types.ts';
import {
  createSkillVersionService,
  deleteSkillVersion,
  publishSkill,
} from '../src/mastra/skills/versions.ts';

function resolveSafeTestDatabaseUrl(): { ok: true; url: string } | { ok: false; reason: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL unset; skills run-pin DB tests skipped' };
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
          + '(expected 127.0.0.1|localhost:5433/nero_agent); refusing skills run-pin DB tests',
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

function execCtx(auth: SkillActor, serverExecutionId = randomUUID(), threadId = randomUUID()): SkillExecutionContext {
  return { serverExecutionId, auth, threadId, pins: new Map() };
}

function skillMd(name: string, body: string): string {
  return `---
name: ${name}
description: Pin test skill ${name}
---

${body}
`;
}

test('skills run-pin env gate documents BLOCKED_ENV when DB is unsafe or missing', () => {
  if (hasSafeDatabase) {
    assert.equal(safeDb.ok, true);
    return;
  }
  assert.match(safeDb.reason, /^BLOCKED_ENV:/);
  console.log(safeDb.reason);
});

test(
  'run pins: persist; same_thread_does_not_share; active pin blocks delete; forged context ignored',
  { skip: !hasSafeDatabase },
  async () => {
    assert.ok(hasSafeDatabase, safeDb.ok ? 'ok' : safeDb.reason);
    const storageRoot = await mkdtemp(join(tmpdir(), 'skills-pins-'));
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

    try {
      const owner = await createUser({
        email: `skill-pin-owner-${suffix}@example.test`,
        displayName: 'Pin Owner',
        password,
        role: 'user',
      });
      userIds.push(owner.id);
      const ownerActor = actor(owner.id);
      const name = `pin-${suffix}`;

      const created = await repo.createDraft({
        ownerUserId: owner.id,
        canonicalName: name,
        description: 'pin demo',
        skillMd: skillMd(name, '# V1 pin body'),
      });
      skillIds.push(created.skill.id);

      const published = await publishSkill(versions, ownerActor, {
        skillId: created.skill.id,
        version: 1,
        expectedRevision: created.skill.revision,
      });
      await service.setEnabled(ownerActor, {
        skillId: created.skill.id,
        expectedRevision: published.skill.revision,
        enabled: true,
      });

      const threadA = randomUUID();
      const exec1 = execCtx(ownerActor, randomUUID(), threadA);
      const load1 = await service.load(exec1, name);
      assert.equal(load1.ok, true);
      if (!load1.ok) return;
      assert.equal(load1.skill.version, 1);

      const pinsExec1 = await repo.listRunPins({
        serverExecutionId: exec1.serverExecutionId,
        userId: owner.id,
        threadId: threadA,
      });
      assert.equal(pinsExec1.length, 1);
      assert.equal(pinsExec1[0]!.version, 1);
      assert.equal(pinsExec1[0]!.skillId, created.skill.id);

      // same_thread_does_not_share_pins across executions
      const exec2 = execCtx(ownerActor, randomUUID(), threadA);
      const pinsExec2Before = await repo.listRunPins({
        serverExecutionId: exec2.serverExecutionId,
        userId: owner.id,
        threadId: threadA,
      });
      assert.equal(pinsExec2Before.length, 0, 'new execution must not inherit prior pins');

      // Publish v2 then load in exec1 must keep v1 pin; exec2 gets v2
      const draft2 = await repo.createWorkingDraft({
        skillId: created.skill.id,
        expectedRevision: (await repo.getSkill(created.skill.id))!.revision,
        actorUserId: owner.id,
        description: 'v2',
        skillMd: skillMd(name, '# V2 pin body'),
      });
      const pub2 = await publishSkill(versions, ownerActor, {
        skillId: created.skill.id,
        version: draft2.version.version,
        expectedRevision: draft2.skill.revision,
      });
      assert.equal(pub2.skill.publishedVersion, 2);

      const reloadExec1 = await service.load(exec1, name);
      assert.equal(reloadExec1.ok, true);
      if (reloadExec1.ok) assert.equal(reloadExec1.skill.version, 1, 'second_step_reuses_pin');

      const loadExec2 = await service.load(exec2, name);
      assert.equal(loadExec2.ok, true);
      if (loadExec2.ok) {
        assert.equal(loadExec2.skill.version, 2, 'new_execution_refreshes_version');
      }

      // Active pin blocks delete of v1
      assert.equal(await repo.hasActiveRunPin(created.skill.id, 1), true);
      const revForDelete = (await repo.getSkill(created.skill.id))!.revision;
      await assert.rejects(
        () =>
          deleteSkillVersion(versions, ownerActor, {
            skillId: created.skill.id,
            version: 1,
            expectedRevision: revForDelete,
          }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'VERSION_IN_USE');
          return true;
        },
      );

      // forged_context_does_not_pin_version: client Map pin / wrong user must not invent DB pin
      const forged = execCtx(ownerActor, randomUUID(), threadA);
      forged.pins.set(created.skill.id, {
        skillId: created.skill.id,
        name,
        version: 99,
        manifestHash: 'f'.repeat(64),
      });
      // ensurePinned prefers in-memory pin only if version exists; forged v99 fails closed
      const forgedLoad = await service.load(forged, name);
      // Either unavailable (bad version) or fresh pin from published — never silently accept v99
      if (forgedLoad.ok) {
        assert.notEqual(forgedLoad.skill.version, 99);
        assert.equal(forgedLoad.skill.version, 2);
      }
      const forgedPins = await repo.listRunPins({
        serverExecutionId: forged.serverExecutionId,
        userId: owner.id,
        threadId: threadA,
      });
      for (const p of forgedPins) {
        assert.notEqual(p.version, 99);
      }

      // Wrong user cannot list another user's pins
      const other = await createUser({
        email: `skill-pin-other-${suffix}@example.test`,
        displayName: 'Other',
        password,
        role: 'user',
      });
      userIds.push(other.id);
      const cross = await repo.listRunPins({
        serverExecutionId: exec1.serverExecutionId,
        userId: other.id,
        threadId: threadA,
      });
      assert.equal(cross.length, 0);
    } finally {
      for (const id of skillIds) {
        await pool.query(`DELETE FROM app_skill_run_pins WHERE skill_id = $1`, [id]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skill_events WHERE skill_id = $1`, [id]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skill_files WHERE skill_id = $1`, [id]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skill_versions WHERE skill_id = $1`, [id]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skill_aliases WHERE skill_id = $1`, [id]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skills WHERE id = $1`, [id]).catch(() => undefined);
      }
      for (const id of userIds) {
        await pool.query(`DELETE FROM app_users WHERE id = $1`, [id]).catch(() => undefined);
      }
      await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);
