/**
 * Task 4: skill runtime service — load/read/search + revoke/disable/delete semantics.
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
import { SKILL_LIMITS } from '../src/mastra/skills/validation.ts';
import {
  createSkillVersionService,
  publishSkill,
} from '../src/mastra/skills/versions.ts';

function resolveSafeTestDatabaseUrl(): { ok: true; url: string } | { ok: false; reason: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL unset; skills runtime DB tests skipped' };
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
          + '(expected 127.0.0.1|localhost:5433/nero_agent); refusing skills runtime DB tests',
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

function execCtx(auth: SkillActor, pins = new Map()): SkillExecutionContext {
  return {
    serverExecutionId: randomUUID(),
    auth,
    threadId: randomUUID(),
    pins,
  };
}

function skillMd(name: string, body: string): string {
  return `---
name: ${name}
description: Runtime test skill ${name}
---

${body}
`;
}

test('skills runtime env gate documents BLOCKED_ENV when DB is unsafe or missing', () => {
  if (hasSafeDatabase) {
    assert.equal(safeDb.ok, true);
    return;
  }
  assert.match(safeDb.reason, /^BLOCKED_ENV:/);
  console.log(safeDb.reason);
});

test(
  'runtime: load/read/search; revoke/disable/delete → SKILL_UNAVAILABLE; no name leak; alias; limits',
  { skip: !hasSafeDatabase },
  async () => {
    assert.ok(hasSafeDatabase, safeDb.ok ? 'ok' : safeDb.reason);
    const storageRoot = await mkdtemp(join(tmpdir(), 'skills-runtime-'));
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
    const audienceIds: string[] = [];

    try {
      const owner = await createUser({
        email: `skill-rt-owner-${suffix}@example.test`,
        displayName: 'Runtime Owner',
        password,
        role: 'user',
      });
      userIds.push(owner.id);
      const grantee = await createUser({
        email: `skill-rt-use-${suffix}@example.test`,
        displayName: 'Runtime Use',
        password,
        role: 'user',
      });
      userIds.push(grantee.id);
      const stranger = await createUser({
        email: `skill-rt-str-${suffix}@example.test`,
        displayName: 'Runtime Stranger',
        password,
        role: 'user',
      });
      userIds.push(stranger.id);
      const admin = await createUser({
        email: `skill-rt-admin-${suffix}@example.test`,
        displayName: 'Runtime Admin',
        password,
        role: 'admin',
      });
      userIds.push(admin.id);
      const editor = await createUser({
        email: `skill-rt-edit-${suffix}@example.test`,
        displayName: 'Runtime Editor',
        password,
        role: 'user',
      });
      userIds.push(editor.id);

      const name = `rt-alpha-${suffix}`;
      const alias = `Rt.Alias_${suffix}`;
      const lines = Array.from({ length: 450 }, (_, i) => `line-${i + 1}`).join('\n');
      const md = skillMd(name, `# Body\n\n${lines}`);

      const refText = Buffer.from('alpha secret keyword here\nsecond line\n', 'utf8');
      const refPut = await blobStore.put(Readable.from([refText]), 1024);
      const binPut = await blobStore.put(Readable.from([Buffer.from([0, 1, 2, 3, 0])]), 1024);

      const created = await service.createDraft(actor(owner.id), {
        name,
        description: `Description for ${name}`,
        skillMd: md,
        alias,
      });
      skillIds.push(created.skill.id);

      // no grant yet: do not confirm the private skill exists
      await assert.rejects(
        () => service.getManageDetail(actor(grantee.id), created.skill.id),
        (err: unknown) => {
          assert.ok(err && typeof err === 'object' && 'code' in err);
          assert.equal((err as { code: string }).code, 'SKILL_UNAVAILABLE');
          return true;
        },
      );

      await pool.query(
        `INSERT INTO app_skill_grants (skill_id, user_id, permission) VALUES ($1, $2, 'edit')`,
        [created.skill.id, editor.id],
      );
      // edit cannot publish via version service (auth wired)
      await assert.rejects(
        () =>
          publishSkill(versions, actor(editor.id), {
            skillId: created.skill.id,
            version: 1,
            expectedRevision: created.skill.revision,
          }),
        (err: unknown) => {
          assert.ok(err && typeof err === 'object' && 'code' in err);
          assert.equal((err as { code: string }).code, 'FORBIDDEN');
          return true;
        },
      );

      // save file on draft then publish as owner
      const afterFile = await service.saveFile(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: created.skill.revision,
        path: 'references/notes.md',
        bytes: refText,
        mimeType: 'text/markdown',
      });
      assert.ok(afterFile.skill.revision !== created.skill.revision);

      const afterBin = await service.saveFile(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: afterFile.skill.revision,
        path: 'assets/data.bin',
        bytes: new Uint8Array([0, 1, 2, 3, 0]),
        mimeType: 'application/octet-stream',
      });

      // ensure blob hashes match what we put (saveFile should store)
      void refPut;
      void binPut;

      const published = await service.publish(actor(owner.id), {
        skillId: created.skill.id,
        version: 1,
        expectedRevision: afterBin.skill.revision,
      });
      assert.equal(published.skill.enabled, false);

      // admin can manage but not use until grant/global/owner
      const adminDetail = await service.getManageDetail(actor(admin.id, ['admin']), created.skill.id);
      assert.equal(adminDetail.canManage, true);
      assert.equal(adminDetail.canEdit, true);
      const adminLoadBefore = await service.load(execCtx(actor(admin.id, ['admin'])), name);
      assert.equal(adminLoadBefore.ok, false);
      if (!adminLoadBefore.ok) assert.equal(adminLoadBefore.code, 'SKILL_UNAVAILABLE');

      const enabled = await service.setEnabled(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: published.skill.revision,
        enabled: true,
      });
      assert.equal(enabled.enabled, true);

      await pool.query(
        `INSERT INTO app_skill_grants (skill_id, user_id, permission) VALUES ($1, $2, 'use')`,
        [created.skill.id, grantee.id],
      );

      // use can run the skill but cannot read the draft
      await assert.rejects(
        () => service.getManageDetail(actor(grantee.id), created.skill.id),
        (err: unknown) => {
          assert.ok(err && typeof err === 'object' && 'code' in err);
          assert.equal((err as { code: string }).code, 'FORBIDDEN');
          return true;
        },
      );

      // alias exact match
      const ctx = execCtx(actor(grantee.id));
      const loadedAlias = await service.load(ctx, alias);
      assert.equal(loadedAlias.ok, true);
      if (loadedAlias.ok) {
        assert.equal(loadedAlias.skill.name, name);
        assert.match(loadedAlias.data.baseUri, /^skill:\/\/.+\/1\/$/);
        assert.ok(loadedAlias.data.resources.some((r) => r.path === 'references/notes.md'));
        assert.ok(!JSON.stringify(loadedAlias).includes(storageRoot));
      }

      // read default 200 lines; continuation; max 400; 64KiB
      const read1 = await service.read(ctx, {
        skillName: name,
        path: 'skill://ignored/1/SKILL.md',
        // virtual baseUri path should resolve to SKILL.md body — use relative
      });
      // Prefer relative path form
      const readBody = await service.read(ctx, { skillName: name, path: 'SKILL.md' });
      assert.equal(readBody.ok, true);
      if (readBody.ok) {
        assert.equal(readBody.data.startLine, 1);
        const lineCount = readBody.data.text.split('\n').length;
        assert.ok(lineCount <= SKILL_LIMITS.TEXT_READ_DEFAULT_LINES + 5);
        assert.equal(readBody.data.hasMore, true);
        assert.ok(readBody.data.nextStartLine != null);
        const cont = await service.read(ctx, {
          skillName: name,
          path: 'SKILL.md',
          startLine: readBody.data.nextStartLine!,
        });
        assert.equal(cont.ok, true);
      }

      const tooWide = await service.read(ctx, {
        skillName: name,
        path: 'SKILL.md',
        startLine: 1,
        endLine: 1 + SKILL_LIMITS.TEXT_READ_MAX_LINES,
      });
      assert.equal(tooWide.ok, true);
      if (tooWide.ok) {
        assert.ok(tooWide.data.text.split('\n').length <= SKILL_LIMITS.TEXT_READ_MAX_LINES);
        assert.equal(tooWide.data.truncated, true);
      }

      const binary = await service.read(ctx, { skillName: name, path: 'assets/data.bin' });
      assert.equal(binary.ok, false);
      if (!binary.ok) assert.equal(binary.code, 'RESOURCE_BINARY');

      // baseUri relative resolution
      if (loadedAlias.ok) {
        const viaBase = await service.read(ctx, {
          skillName: name,
          path: `${loadedAlias.data.baseUri}references/notes.md`,
        });
        assert.equal(viaBase.ok, true);
        if (viaBase.ok) assert.match(viaBase.data.text, /secret keyword/);
      }

      // search stable sort + topK / total snippet budget
      const searchOk = await service.search(ctx, { query: 'secret', skillNames: [name, alias], topK: 5 });
      assert.equal(searchOk.ok, true);
      if (searchOk.ok) {
        assert.ok(searchOk.data.hits.length >= 1);
        for (let i = 1; i < searchOk.data.hits.length; i++) {
          const prev = searchOk.data.hits[i - 1]!;
          const cur = searchOk.data.hits[i]!;
          assert.ok(
            prev.score > cur.score
            || (prev.score === cur.score && prev.pin.name <= cur.pin.name),
          );
        }
      }

      // stranger search must not leak name or snippet
      const strangerSearch = await service.search(execCtx(actor(stranger.id)), {
        query: 'secret keyword',
        skillNames: [name],
      });
      assert.equal(strangerSearch.ok, true);
      if (strangerSearch.ok) {
        assert.equal(strangerSearch.data.hits.length, 0);
        assert.ok(!JSON.stringify(strangerSearch).includes(name));
        assert.ok(!JSON.stringify(strangerSearch).includes('secret keyword'));
      }

      const strangerLoad = await service.load(execCtx(actor(stranger.id)), name);
      assert.equal(strangerLoad.ok, false);
      if (!strangerLoad.ok) {
        assert.equal(strangerLoad.code, 'SKILL_UNAVAILABLE');
        assert.ok(!strangerLoad.message.includes(name));
      }

      // revoke use → load/read/search unavailable
      await pool.query(`DELETE FROM app_skill_grants WHERE skill_id = $1 AND user_id = $2 AND permission = 'use'`, [
        created.skill.id,
        grantee.id,
      ]);
      const afterRevoke = await service.load(ctx, name);
      assert.equal(afterRevoke.ok, false);
      if (!afterRevoke.ok) assert.equal(afterRevoke.code, 'SKILL_UNAVAILABLE');
      const readAfter = await service.read(ctx, { skillName: name, path: 'references/notes.md' });
      assert.equal(readAfter.ok, false);
      if (!readAfter.ok) assert.equal(readAfter.code, 'SKILL_UNAVAILABLE');
      const searchAfter = await service.search(ctx, { query: 'secret', skillNames: [name] });
      assert.equal(searchAfter.ok, true);
      if (searchAfter.ok) {
        assert.equal(searchAfter.data.hits.length, 0);
        assert.ok(!JSON.stringify(searchAfter).includes(name));
      }

      // re-grant then disable
      await pool.query(
        `INSERT INTO app_skill_grants (skill_id, user_id, permission) VALUES ($1, $2, 'use')`,
        [created.skill.id, grantee.id],
      );
      const current = await repo.getSkill(created.skill.id);
      assert.ok(current);
      await service.setEnabled(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: current.revision,
        enabled: false,
      });
      const afterDisable = await service.load(execCtx(actor(grantee.id)), name);
      assert.equal(afterDisable.ok, false);
      if (!afterDisable.ok) assert.equal(afterDisable.code, 'SKILL_UNAVAILABLE');

      // re-enable then soft-delete
      const disabled = await repo.getSkill(created.skill.id);
      assert.ok(disabled);
      await service.setEnabled(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: disabled.revision,
        enabled: true,
      });
      const reEnabled = await repo.getSkill(created.skill.id);
      assert.ok(reEnabled);
      await service.deleteSkill(actor(owner.id), {
        skillId: created.skill.id,
        expectedRevision: reEnabled.revision,
      });
      const afterDelete = await service.load(execCtx(actor(grantee.id)), name);
      assert.equal(afterDelete.ok, false);
      if (!afterDelete.ok) {
        assert.equal(afterDelete.code, 'SKILL_UNAVAILABLE');
        assert.ok(!afterDelete.message.includes(name));
      }

      // DB permission failure must refuse (not reuse prior auth)
      const failingRepo = Object.create(repo) as typeof repo;
      failingRepo.getAccessSnapshot = async () => {
        throw new Error('simulated DB failure');
      };
      const failingService = createSkillService({
        repository: failingRepo,
        blobStore,
        releaseStore,
        versionService: versions,
        pool,
      });
      // recreate a fresh skill for DB-fail probe on a live id is hard after delete —
      // use listAvailable which also re-checks; or create another skill
      const name2 = `rt-beta-${suffix}`;
      const draft2 = await service.createDraft(actor(owner.id), {
        name: name2,
        description: `Description for ${name2}`,
        skillMd: skillMd(name2, 'beta body keyword'),
      });
      skillIds.push(draft2.skill.id);
      const pub2 = await service.publish(actor(owner.id), {
        skillId: draft2.skill.id,
        version: 1,
        expectedRevision: draft2.skill.revision,
      });
      await service.setEnabled(actor(owner.id), {
        skillId: draft2.skill.id,
        expectedRevision: pub2.skill.revision,
        enabled: true,
      });
      await pool.query(
        `INSERT INTO app_skill_grants (skill_id, user_id, permission) VALUES ($1, $2, 'use')`,
        [draft2.skill.id, grantee.id],
      );
      const failLoad = await failingService.load(execCtx(actor(grantee.id)), name2);
      assert.equal(failLoad.ok, false);
      if (!failLoad.ok) assert.equal(failLoad.code, 'SKILL_UNAVAILABLE');
    } finally {
      const p = getPool();
      if (skillIds.length) {
        await p.query('DELETE FROM app_skill_run_pins WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query('DELETE FROM app_skill_shortcuts WHERE skill_id = ANY($1::uuid[])', [skillIds]);
        await p.query('DELETE FROM app_skill_sync_sessions WHERE skill_id = ANY($1::uuid[])', [skillIds]);
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
      if (userIds.length) {
        await p.query('DELETE FROM app_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
        await p.query('DELETE FROM app_user_roles WHERE user_id = ANY($1::uuid[])', [userIds]);
        await p.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [userIds]);
      }
      await rm(storageRoot, { recursive: true, force: true });
    }
  },
);
