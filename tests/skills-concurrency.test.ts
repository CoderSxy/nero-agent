/**
 * Task 9: concurrent management — CAS conflicts, dual publish, revoke-then-save, sync stub race.
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
import type { SkillActor, SkillRecord } from '../src/mastra/skills/types.ts';
import { createSkillVersionService } from '../src/mastra/skills/versions.ts';

function resolveSafeTestDatabaseUrl(): { ok: true; url: string } | { ok: false; reason: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL unset; skills concurrency DB tests skipped' };
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
          + '(expected 127.0.0.1|localhost:5433/nero_agent); refusing skills concurrency DB tests',
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

function skillMd(name: string, marker: string): string {
  return `---
name: ${name}
description: Concurrency test skill ${name}
---

# ${marker}
`;
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof SkillRepositoryError && error.code === 'REVISION_CONFLICT';
}

function isNameConflict(error: unknown): boolean {
  return error instanceof SkillRepositoryError && error.code === 'NAME_CONFLICT';
}

test('skills concurrency env gate documents BLOCKED_ENV when DB is unsafe or missing', () => {
  if (hasSafeDatabase) {
    assert.equal(safeDb.ok, true);
    return;
  }
  assert.match(safeDb.reason, /^BLOCKED_ENV:/);
  console.log(safeDb.reason);
});

test(
  'concurrency: owner+edit save CAS; dual publish; sync stub race; name race; revoke edit then save',
  { skip: !hasSafeDatabase },
  async () => {
    assert.ok(hasSafeDatabase, safeDb.ok ? 'ok' : safeDb.reason);
    const storageRoot = await mkdtemp(join(tmpdir(), 'skills-conc-'));
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
        email: `skill-conc-owner-${suffix}@example.test`,
        displayName: 'Conc Owner',
        password,
        role: 'user',
      });
      userIds.push(owner.id);
      const editor = await createUser({
        email: `skill-conc-edit-${suffix}@example.test`,
        displayName: 'Conc Editor',
        password,
        role: 'user',
      });
      userIds.push(editor.id);

      const name = `conc-${suffix}`;
      const created = await service.createDraft(actor(owner.id), {
        name,
        description: `Description for ${name}`,
        skillMd: skillMd(name, 'BASE'),
      });
      skillIds.push(created.skill.id);

      await service.setMetadata(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: created.skill.revision,
        grants: [{ userId: editor.id, permission: 'edit' }],
      });
      const afterGrant = await repo.getSkill(created.skill.id);
      assert.ok(afterGrant);
      const baseRevision = afterGrant.revision;

      // owner + edit concurrent save with same expectedRevision → one wins, loser 409, no overwrite retry
      const ownerMd = skillMd(name, 'OWNER-WIN');
      const editorMd = skillMd(name, 'EDITOR-WIN');
      const saveResults = await Promise.allSettled([
        service.saveDraft(actor(owner.id), {
          skillId: created.skill.id,
          expectedRevision: baseRevision,
          skillMd: ownerMd,
        }),
        service.saveDraft(actor(editor.id), {
          skillId: created.skill.id,
          expectedRevision: baseRevision,
          skillMd: editorMd,
        }),
      ]);
      const fulfilled = saveResults.filter((r) => r.status === 'fulfilled');
      const rejected = saveResults.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.ok(isRevisionConflict((rejected[0] as PromiseRejectedResult).reason));

      const winner = (fulfilled[0] as PromiseFulfilledResult<{ skill: SkillRecord; version: { skillMd: string } }>)
        .value;
      const draftAfter = await repo.getDraftVersion(created.skill.id);
      assert.ok(draftAfter);
      assert.equal(draftAfter.skillMd, winner.version.skillMd);
      assert.ok(
        draftAfter.skillMd.includes('OWNER-WIN') || draftAfter.skillMd.includes('EDITOR-WIN'),
      );
      assert.ok(
        !(draftAfter.skillMd.includes('OWNER-WIN') && draftAfter.skillMd.includes('EDITOR-WIN')),
      );
      // CAS loser must not overwrite: server keeps winner content only
      const loserTriedOwner = winner.version.skillMd.includes('EDITOR-WIN');
      if (loserTriedOwner) {
        assert.ok(!draftAfter.skillMd.includes('OWNER-WIN'));
      } else {
        assert.ok(!draftAfter.skillMd.includes('EDITOR-WIN'));
      }

      // revoke edit → already-open editor page save fails
      const beforeRevoke = await repo.getSkill(created.skill.id);
      assert.ok(beforeRevoke);
      const afterRevokeGrant = await service.setMetadata(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: beforeRevoke.revision,
        grants: [],
      });
      await assert.rejects(
        () =>
          service.saveDraft(actor(editor.id), {
            skillId: created.skill.id,
            expectedRevision: afterRevokeGrant.revision,
            skillMd: skillMd(name, 'REVOKED-SAVE'),
          }),
        (error: unknown) => {
          assert.ok(error instanceof SkillPolicyError);
          assert.equal(error.code, 'FORBIDDEN');
          return true;
        },
      );
      const mdAfterRevoke = await repo.getDraftVersion(created.skill.id);
      assert.ok(mdAfterRevoke);
      assert.ok(!mdAfterRevoke.skillMd.includes('REVOKED-SAVE'));

      // dual publish race (real DB)
      const pubName = `dual-pub-${suffix}`;
      const dual = await service.createDraft(actor(owner.id), {
        name: pubName,
        description: `Description for ${pubName}`,
        skillMd: skillMd(pubName, 'PUB'),
      });
      skillIds.push(dual.skill.id);
      const dualResults = await Promise.allSettled([
        service.publish(actor(owner.id), {
          skillId: dual.skill.id,
          version: 1,
          expectedRevision: dual.skill.revision,
        }),
        service.publish(actor(owner.id), {
          skillId: dual.skill.id,
          version: 1,
          expectedRevision: dual.skill.revision,
        }),
      ]);
      const dualOk = dualResults.filter((r) => r.status === 'fulfilled');
      const dualFail = dualResults.filter((r) => r.status === 'rejected');
      assert.equal(dualOk.length, 1);
      assert.equal(dualFail.length, 1);
      const dualReason = (dualFail[0] as PromiseRejectedResult).reason as {
        code?: string;
        name?: string;
        message?: string;
      };
      // LOSER: revision CAS, version already published, or concurrent release materialize clash.
      const dualCode = dualReason?.code ?? '';
      assert.ok(
        dualCode === 'REVISION_CONFLICT'
          || dualCode === 'VERSION_NOT_DRAFT'
          || dualCode === 'RELEASE_RENAME_FAILED'
          || dualCode === 'RELEASE_INCOMPLETE',
        `unexpected dual-publish loser: ${dualReason?.name}/${dualCode}/${dualReason?.message}`,
      );
      const dualSkill = await repo.getSkill(dual.skill.id);
      assert.equal(dualSkill?.publishedVersion, 1);

      // publish vs sync stub race (Task 12 sync not landed — stub as concurrent draft file write)
      const syncName = `sync-race-${suffix}`;
      const syncSkill = await service.createDraft(actor(owner.id), {
        name: syncName,
        description: `Description for ${syncName}`,
        skillMd: skillMd(syncName, 'SYNC'),
      });
      skillIds.push(syncSkill.skill.id);
      const syncRev = syncSkill.skill.revision;
      const syncRace = await Promise.allSettled([
        service.publish(actor(owner.id), {
          skillId: syncSkill.skill.id,
          version: 1,
          expectedRevision: syncRev,
        }),
        service.saveDraft(actor(owner.id), {
          skillId: syncSkill.skill.id,
          expectedRevision: syncRev,
          skillMd: skillMd(syncName, 'SYNC-STUB'),
        }),
      ]);
      const syncOk = syncRace.filter((r) => r.status === 'fulfilled');
      const syncFail = syncRace.filter((r) => r.status === 'rejected');
      assert.equal(syncOk.length, 1);
      assert.equal(syncFail.length, 1);
      assert.ok(isRevisionConflict((syncFail[0] as PromiseRejectedResult).reason));
      const afterSyncRace = await repo.getSkill(syncSkill.skill.id);
      assert.ok(afterSyncRace);
      // whichever won: either published pointer set OR draft updated — not a half state of both without CAS
      if (afterSyncRace.publishedVersion === 1) {
        const v1 = await repo.getVersion(syncSkill.skill.id, 1);
        assert.equal(v1?.state, 'published');
        assert.ok(!v1?.skillMd.includes('SYNC-STUB'));
      } else {
        assert.equal(afterSyncRace.publishedVersion, null);
        const draft = await repo.getDraftVersion(syncSkill.skill.id);
        assert.ok(draft?.skillMd.includes('SYNC-STUB'));
      }

      // same-name import race (createDraft concurrent)
      const conflictName = `name-race-${suffix}`;
      const nameRace = await Promise.allSettled([
        service.createDraft(actor(owner.id), {
          name: conflictName,
          description: `Description for ${conflictName}`,
          skillMd: skillMd(conflictName, 'A'),
        }),
        service.createDraft(actor(editor.id), {
          name: conflictName,
          description: `Description for ${conflictName}`,
          skillMd: skillMd(conflictName, 'B'),
        }),
      ]);
      const nameOk = nameRace.filter((r) => r.status === 'fulfilled');
      const nameFail = nameRace.filter((r) => r.status === 'rejected');
      assert.equal(nameOk.length, 1);
      assert.equal(nameFail.length, 1);
      assert.ok(isNameConflict((nameFail[0] as PromiseRejectedResult).reason));
      const winnerCreate = (nameOk[0] as PromiseFulfilledResult<{ skill: SkillRecord }>).value;
      skillIds.push(winnerCreate.skill.id);

      // authorization change concurrent with save: grant bump + stale save → 409
      const authName = `auth-race-${suffix}`;
      const authSkill = await service.createDraft(actor(owner.id), {
        name: authName,
        description: `Description for ${authName}`,
        skillMd: skillMd(authName, 'AUTH'),
      });
      skillIds.push(authSkill.skill.id);
      await service.setMetadata(actor(owner.id), {
        skillId: authSkill.skill.id,
        expectedRevision: authSkill.skill.revision,
        grants: [{ userId: editor.id, permission: 'edit' }],
      });
      const authBase = await repo.getSkill(authSkill.skill.id);
      assert.ok(authBase);
      const authRace = await Promise.allSettled([
        service.setMetadata(actor(owner.id), {
          skillId: authSkill.skill.id,
          expectedRevision: authBase.revision,
          grants: [{ userId: editor.id, permission: 'use' }],
        }),
        service.saveDraft(actor(editor.id), {
          skillId: authSkill.skill.id,
          expectedRevision: authBase.revision,
          skillMd: skillMd(authName, 'AUTH-SAVE'),
        }),
      ]);
      const authFulfilled = authRace.filter((r) => r.status === 'fulfilled');
      const authRejected = authRace.filter((r) => r.status === 'rejected');
      assert.equal(authFulfilled.length, 1);
      assert.equal(authRejected.length, 1);
      assert.ok(isRevisionConflict((authRejected[0] as PromiseRejectedResult).reason));
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
      if (userIds.length) {
        await p.query('DELETE FROM app_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
        await p.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [userIds]);
      }
      await rm(storageRoot, { recursive: true, force: true });
    }
  },
);
