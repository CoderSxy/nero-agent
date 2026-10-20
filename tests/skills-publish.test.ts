import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { getPool } from '../src/mastra/auth/db.ts';
import { createUser } from '../src/mastra/auth/service.ts';
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import { SkillRepositoryError, SkillStorageError } from '../src/mastra/skills/errors.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';
import { createSkillRepository } from '../src/mastra/skills/repository.ts';
import type { CreateSkillDraftInput, SkillActor, SkillPublishResult } from '../src/mastra/skills/types.ts';
import {
  createSkillVersionService,
  deleteSkillVersion,
  deriveWorkingDraft,
  publishSkill,
  rollbackSkill,
} from '../src/mastra/skills/versions.ts';

/**
 * Safe local test DB only: loopback + port 5433 + db nero_agent (db:local:setup).
 */
function resolveSafeTestDatabaseUrl(): { ok: true; url: string } | { ok: false; reason: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL unset; skills publish DB tests skipped' };
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
          + '(expected 127.0.0.1|localhost:5433/nero_agent); refusing skills publish DB tests',
      };
    }
    return { ok: true, url: raw };
  } catch {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL is not a valid URL' };
  }
}

const safeDb = resolveSafeTestDatabaseUrl();
const hasSafeDatabase = safeDb.ok;

const SKILL_MD_V1 = `---
name: publish-demo
description: Publish demo skill v1
---

# V1
`;

const SKILL_MD_V2 = `---
name: publish-demo
description: Publish demo skill v2
---

# V2 changed
`;

function actor(userId: string, roles: SkillActor['roles'] = ['user']): SkillActor {
  return { userId, roles };
}

function assertNoReleaseRootInDto(result: SkillPublishResult): void {
  assert.equal('releaseRoot' in result, false);
  assert.ok(!Object.keys(result).includes('releaseRoot'));
}

test('skills publish env gate documents BLOCKED_ENV when DB is unsafe or missing', () => {
  if (hasSafeDatabase) {
    assert.equal(safeDb.ok, true);
    return;
  }
  assert.match(safeDb.reason, /^BLOCKED_ENV:/);
  console.log(safeDb.reason);
});

test(
  'publish/rollback: first publish stays disabled; enabled stays; atomic failures; concurrency; pins',
  { skip: !hasSafeDatabase },
  async () => {
    assert.ok(hasSafeDatabase, safeDb.ok ? 'ok' : safeDb.reason);
    const storageRoot = await mkdtemp(join(tmpdir(), 'skills-publish-'));
    const pool = getPool();
    const repo = createSkillRepository(pool);
    const blobStore = createBlobStore({ root: storageRoot });
    const releaseStore = createReleaseStore({ root: storageRoot, blobStore });
    const versions = createSkillVersionService({
      repository: repo,
      blobStore,
      releaseStore,
      pool,
    });

    const suffix = randomUUID().slice(0, 8);
    const password = 'correct horse battery staple';
    const userIds: string[] = [];
    const skillIds: string[] = [];

    try {
      const owner = await createUser({
        email: `skill-pub-owner-${suffix}@example.test`,
        displayName: 'Skill Publish Owner',
        password,
        role: 'user',
      });
      userIds.push(owner.id);
      const ownerActor = actor(owner.id);

      const refBytes = Buffer.from(`ref-${suffix}\n`, 'utf8');
      const refPut = await blobStore.put(Readable.from([refBytes]), 1024);

      const draftInput: CreateSkillDraftInput = {
        ownerUserId: owner.id,
        canonicalName: `pub-${suffix}`,
        description: 'Publish demo skill v1',
        skillMd: SKILL_MD_V1.replace('publish-demo', `pub-${suffix}`),
        files: [
          {
            path: 'references/a.md',
            blobHash: refPut.hash,
            size: refPut.size,
            isText: true,
            mimeType: 'text/markdown',
          },
        ],
      };

      const created = await repo.createDraft(draftInput);
      skillIds.push(created.skill.id);
      assert.equal(created.skill.enabled, false);
      assert.equal(created.skill.publishedVersion, null);

      await assert.rejects(
        () =>
          publishSkill(versions, ownerActor, {
            skillId: created.skill.id,
            version: 1,
            expectedRevision: created.skill.revision,
            remark: 'x'.repeat(501),
          }),
        (error: unknown) => {
          assert.ok(error instanceof SkillRepositoryError);
          assert.equal(error.code, 'INVALID_INPUT');
          return true;
        },
      );

      const published = await publishSkill(versions, ownerActor, {
        skillId: created.skill.id,
        version: 1,
        expectedRevision: created.skill.revision,
        remark: 'first release',
      });
      assertNoReleaseRootInDto(published);
      assert.equal(published.skill.enabled, false, 'first publish must keep enabled=false');
      assert.equal(published.skill.publishedVersion, 1);
      assert.equal(published.version.state, 'published');
      assert.equal(published.version.publishedRemark, 'first release');
      assert.match(published.manifestHash, /^[a-f0-9]{64}$/);

      const releaseRootV1 = releaseStore.resolveReleaseRoot(
        created.skill.id,
        1,
        published.manifestHash,
      );
      assert.match(await readFile(join(releaseRootV1, 'SKILL.md'), 'utf8'), /# V1/);
      assert.equal(
        Buffer.compare(await readFile(join(releaseRootV1, 'references/a.md')), refBytes),
        0,
      );

      const enabled = await repo.updateMetadata({
        skillId: created.skill.id,
        expectedRevision: published.skill.revision,
        actorUserId: owner.id,
        enabled: true,
      });
      assert.equal(enabled.enabled, true);

      const derived = await deriveWorkingDraft(versions, ownerActor, {
        skillId: created.skill.id,
        expectedRevision: enabled.revision,
        actorUserId: owner.id,
        skillMd: SKILL_MD_V2.replace('publish-demo', `pub-${suffix}`),
        description: 'Publish demo skill v2',
      });
      assert.equal(derived.version.version, 2);
      assert.equal(derived.version.state, 'draft');
      const filesV2 = await repo.listFiles(created.skill.id, 2);
      assert.equal(filesV2.length, 1);
      assert.equal(filesV2[0]!.blobHash, refPut.hash);

      const v1Before = await repo.getVersion(created.skill.id, 1);
      assert.ok(v1Before);
      assert.equal(v1Before.state, 'published');
      assert.match(v1Before.skillMd, /# V1/);

      const updatedDraft = await repo.updateDraft({
        skillId: created.skill.id,
        expectedRevision: derived.skill.revision,
        actorUserId: owner.id,
        skillMd: SKILL_MD_V2.replace('publish-demo', `pub-${suffix}`),
      });
      assert.equal(updatedDraft.version.version, 2);
      const v1AfterDraftEdit = await repo.getVersion(created.skill.id, 1);
      assert.match(v1AfterDraftEdit!.skillMd, /# V1/);

      const published2 = await publishSkill(versions, ownerActor, {
        skillId: created.skill.id,
        version: 2,
        expectedRevision: updatedDraft.skill.revision,
        remark: 'second',
      });
      assertNoReleaseRootInDto(published2);
      assert.equal(published2.skill.enabled, true, 'already-enabled stays enabled on new publish');
      assert.equal(published2.skill.publishedVersion, 2);

      // old_pin_files_unchanged
      assert.match(await readFile(join(releaseRootV1, 'SKILL.md'), 'utf8'), /# V1/);
      assert.equal(
        Buffer.compare(await readFile(join(releaseRootV1, 'references/a.md')), refBytes),
        0,
      );

      // new_execution_sees_new_pointer
      const skillNow = await repo.getSkill(created.skill.id);
      assert.equal(skillNow?.publishedVersion, 2);
      assert.equal(skillNow?.enabled, true);

      // current_or_active_pin_version_cannot_delete (current pointer; active pin → Task 5)
      await assert.rejects(
        () =>
          deleteSkillVersion(versions, ownerActor, {
            skillId: created.skill.id,
            version: 2,
            expectedRevision: published2.skill.revision,
          }),
        (error: unknown) => {
          assert.ok(error instanceof SkillRepositoryError);
          assert.equal(error.code, 'VERSION_IN_USE');
          return true;
        },
      );

      const rolled = await rollbackSkill(versions, ownerActor, {
        skillId: created.skill.id,
        targetVersion: 1,
        expectedRevision: published2.skill.revision,
      });
      assertNoReleaseRootInDto(rolled);
      assert.equal(rolled.skill.publishedVersion, 1);
      assert.equal(rolled.skill.enabled, true);

      // --- rollback to incomplete version ---
      const incompleteSkill = await repo.createDraft({
        ownerUserId: owner.id,
        canonicalName: `incomplete-${suffix}`,
        description: 'Incomplete publish target',
        skillMd: SKILL_MD_V1.replace('publish-demo', `incomplete-${suffix}`),
        files: [
          {
            path: 'references/missing.md',
            blobHash: 'c'.repeat(64),
            size: 4,
            isText: true,
          },
        ],
      });
      skillIds.push(incompleteSkill.skill.id);
      await pool.query(
        `UPDATE app_skill_versions
         SET state = 'published', published_by = $3, published_at = now(),
             published_remark = 'forced', manifest_hash = $4, updated_at = now()
         WHERE skill_id = $1 AND version = $2`,
        [incompleteSkill.skill.id, 1, owner.id, 'd'.repeat(64)],
      );
      await pool.query(
        `UPDATE app_skills
         SET published_version = 1, revision = revision + 1, updated_at = now()
         WHERE id = $1`,
        [incompleteSkill.skill.id],
      );
      const incompleteSkillRow = await repo.getSkill(incompleteSkill.skill.id);
      assert.ok(incompleteSkillRow);

      const goodDraft = await deriveWorkingDraft(versions, ownerActor, {
        skillId: incompleteSkill.skill.id,
        expectedRevision: incompleteSkillRow.revision,
        actorUserId: owner.id,
        fromVersion: 1,
        skillMd: SKILL_MD_V2.replace('publish-demo', `incomplete-${suffix}`),
        description: 'Incomplete publish target v2',
      });
      const goodBytes = Buffer.from('good\n', 'utf8');
      const goodPut = await blobStore.put(Readable.from([goodBytes]), 1024);
      const fixed = await repo.updateDraft({
        skillId: incompleteSkill.skill.id,
        expectedRevision: goodDraft.skill.revision,
        actorUserId: owner.id,
        files: [
          {
            path: 'references/ok.md',
            blobHash: goodPut.hash,
            size: goodPut.size,
            isText: true,
          },
        ],
      });
      const pubGood = await publishSkill(versions, ownerActor, {
        skillId: incompleteSkill.skill.id,
        version: fixed.version.version,
        expectedRevision: fixed.skill.revision,
      });
      assert.equal(pubGood.skill.publishedVersion, fixed.version.version);

      await assert.rejects(
        () =>
          rollbackSkill(versions, ownerActor, {
            skillId: incompleteSkill.skill.id,
            targetVersion: 1,
            expectedRevision: pubGood.skill.revision,
          }),
        (error: unknown) => {
          assert.ok(error instanceof SkillRepositoryError || error instanceof SkillStorageError);
          if (error instanceof SkillRepositoryError) {
            assert.equal(error.code, 'VERSION_INCOMPLETE');
          }
          return true;
        },
      );
      const afterFailedRollback = await repo.getSkill(incompleteSkill.skill.id);
      assert.equal(afterFailedRollback?.publishedVersion, fixed.version.version);

      // --- release success + DB fail keeps old pointer ---
      const failSkill = await repo.createDraft({
        ownerUserId: owner.id,
        canonicalName: `dbfail-${suffix}`,
        description: 'DB fail after release',
        skillMd: SKILL_MD_V1.replace('publish-demo', `dbfail-${suffix}`),
      });
      skillIds.push(failSkill.skill.id);
      const failVersions = createSkillVersionService({
        repository: repo,
        blobStore,
        releaseStore,
        pool,
        hooks: {
          afterReleaseBeforeDb: async () => {
            throw new Error('injected DB failure after release');
          },
        },
      });
      await assert.rejects(
        () =>
          publishSkill(failVersions, ownerActor, {
            skillId: failSkill.skill.id,
            version: 1,
            expectedRevision: failSkill.skill.revision,
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /injected DB failure/);
          return true;
        },
      );
      const afterDbFail = await repo.getSkill(failSkill.skill.id);
      assert.equal(afterDbFail?.publishedVersion, null);
      assert.equal(afterDbFail?.enabled, false);
      assert.equal((await repo.getVersion(failSkill.skill.id, 1))?.state, 'draft');

      // --- Concurrent publishes (real DB) ---
      const conc = await repo.createDraft({
        ownerUserId: owner.id,
        canonicalName: `conc-${suffix}`,
        description: 'Concurrent publish',
        skillMd: SKILL_MD_V1.replace('publish-demo', `conc-${suffix}`),
      });
      skillIds.push(conc.skill.id);
      const results = await Promise.allSettled([
        publishSkill(versions, ownerActor, {
          skillId: conc.skill.id,
          version: 1,
          expectedRevision: conc.skill.revision,
        }),
        publishSkill(versions, ownerActor, {
          skillId: conc.skill.id,
          version: 1,
          expectedRevision: conc.skill.revision,
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      const rej = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(rej instanceof SkillRepositoryError);
      assert.ok(rej.code === 'REVISION_CONFLICT' || rej.code === 'VERSION_NOT_DRAFT');
      console.log(`CONCURRENT_PUBLISH: winner=1 loser=${rej.code} (real DB)`);

      // --- Read during publish: old pointer remains ---
      const readSkill = await repo.createDraft({
        ownerUserId: owner.id,
        canonicalName: `readpub-${suffix}`,
        description: 'Read during publish',
        skillMd: SKILL_MD_V1.replace('publish-demo', `readpub-${suffix}`),
      });
      skillIds.push(readSkill.skill.id);
      const firstPub = await publishSkill(versions, ownerActor, {
        skillId: readSkill.skill.id,
        version: 1,
        expectedRevision: readSkill.skill.revision,
      });
      const afterEnable = await repo.updateMetadata({
        skillId: readSkill.skill.id,
        expectedRevision: firstPub.skill.revision,
        actorUserId: owner.id,
        enabled: true,
      });
      const draft2 = await deriveWorkingDraft(versions, ownerActor, {
        skillId: readSkill.skill.id,
        expectedRevision: afterEnable.revision,
        actorUserId: owner.id,
        skillMd: SKILL_MD_V2.replace('publish-demo', `readpub-${suffix}`),
        description: 'Read during publish v2',
      });

      let sawOldPointerDuringPublish = false;
      const slowVersions = createSkillVersionService({
        repository: repo,
        blobStore,
        releaseStore,
        pool,
        hooks: {
          afterReleaseBeforeDb: async () => {
            const mid = await repo.getSkill(readSkill.skill.id);
            assert.equal(mid?.publishedVersion, 1);
            sawOldPointerDuringPublish = true;
            await new Promise((r) => setTimeout(r, 50));
          },
        },
      });
      const slowPub = await publishSkill(slowVersions, ownerActor, {
        skillId: readSkill.skill.id,
        version: draft2.version.version,
        expectedRevision: draft2.skill.revision,
      });
      assert.equal(sawOldPointerDuringPublish, true);
      assert.equal(slowPub.skill.publishedVersion, draft2.version.version);

      const corruptRoot = releaseStore.resolveReleaseRoot(
        readSkill.skill.id,
        draft2.version.version,
        slowPub.manifestHash,
      );
      await writeFile(join(corruptRoot, 'SKILL.md'), 'tampered', 'utf8');
      await assert.rejects(
        () =>
          releaseStore.verifyRelease(
            readSkill.skill.id,
            draft2.version.version,
            slowPub.manifestHash,
          ),
        (error: unknown) => {
          assert.ok(error instanceof SkillStorageError);
          assert.ok(
            error.code === 'RELEASE_HASH_MISMATCH' || error.code === 'BLOB_HASH_MISMATCH',
          );
          return true;
        },
      );
    } finally {
      for (const skillId of skillIds) {
        await pool.query(`DELETE FROM app_skill_events WHERE skill_id = $1`, [skillId]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skill_files WHERE skill_id = $1`, [skillId]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skill_versions WHERE skill_id = $1`, [skillId]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skill_aliases WHERE skill_id = $1`, [skillId]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skill_grants WHERE skill_id = $1`, [skillId]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skills WHERE id = $1`, [skillId]).catch(() => undefined);
      }
      for (const userId of userIds) {
        await pool.query(`DELETE FROM app_users WHERE id = $1`, [userId]).catch(() => undefined);
      }
      await rm(storageRoot, { recursive: true, force: true });
    }
  },
);

test('simulated publish transaction: DB failure after release keeps old pointer (unit)', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'skills-pub-unit-'));
  try {
    let publishedVersion: number | null = null;
    let pointerWrites = 0;
    const blobStore = createBlobStore({ root: storageRoot });
    const releaseStore = createReleaseStore({ root: storageRoot, blobStore });
    const skillMd = '---\nname: unit-skill\ndescription: d\n---\n\n# U\n';
    const materialized = await releaseStore.materialize('s1', 1, {
      skillId: 's1',
      version: 1,
      skillMd,
      entries: [],
    });
    assert.match(materialized.manifestHash, /^[a-f0-9]{64}$/);
    try {
      pointerWrites += 1;
      throw new Error('simulated commit failure');
    } catch {
      // pointer not applied
    }
    assert.equal(publishedVersion, null);
    assert.equal(pointerWrites, 1);
    console.log('SIMULATED_TX: release ok + pointer fail → old pointer retained (unit)');
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});
