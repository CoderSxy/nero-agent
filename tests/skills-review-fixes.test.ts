import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { createSkillProcessor } from '../src/mastra/skills/processor.ts';
import { bindSkillServerExecutionId, bindSkillThreadId } from '../src/mastra/skills/execution-context.ts';
import { getPool } from '../src/mastra/auth/db.ts';
import { createUser } from '../src/mastra/auth/service.ts';
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';
import { createSkillRepository, validateSkillVersionResources } from '../src/mastra/skills/repository.ts';
import { createSkillService } from '../src/mastra/skills/service.ts';
import { createSkillVersionService, publishSkill } from '../src/mastra/skills/versions.ts';
import { SKILL_LIMITS } from '../src/mastra/skills/validation.ts';
import type { SkillActor, SkillExecutionContext } from '../src/mastra/skills/types.ts';

function safeDatabase() {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.port === '5433' && url.pathname === '/nero_agent';
  } catch { return false; }
}

test('complete version validation rejects count, aggregate size, casefold and NFC collisions', () => {
  assert.throws(() => validateSkillVersionResources('md', Array.from({ length: 1000 }, (_, n) => ({ path: `assets/${n}`, size: 1 }))), /files/i);
  assert.throws(() => validateSkillVersionResources('md', ['a', 'b', 'c'].map(path => ({ path, size: 80 * 1024 * 1024 }))), /size|bytes/i);
  assert.throws(() => validateSkillVersionResources('md', [{ path: 'A.txt', size: 1 }, { path: 'a.txt', size: 1 }]), /collision/i);
  assert.throws(() => validateSkillVersionResources('md', [{ path: 'é.txt', size: 1 }, { path: 'e\u0301.txt', size: 1 }]), /collision|noncanonical/i);
});

test('real DB: authorization readback, pin failure/conflict and per-file runtime/limits are consistent', { skip: !safeDatabase() }, async () => {
  const pool = getPool();
  const root = await mkdtemp(join(tmpdir(), 'skills-nine-fixes-'));
  const users: string[] = [];
  const skills: string[] = [];
  const repository = createSkillRepository(pool);
  const blobStore = createBlobStore({ root });
  const releaseStore = createReleaseStore({ root, blobStore });
  const versionService = createSkillVersionService({ repository, blobStore, releaseStore, pool });
  const service = createSkillService({ repository, blobStore, releaseStore, versionService, pool });
  const md = (name: string) => `---\nname: ${name}\ndescription: review fixes\n---\nInstruction body\n`;
  const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  try {
    const user = await createUser({ email: `skill-fix-${randomUUID()}@test.invalid`, password: 'Review-fix-strong-password-42!', displayName: 'skill fixes', role: 'user' });
    users.push(user.id);
    const grantee = await createUser({ email: `skill-grant-${randomUUID()}@test.invalid`, password: 'Review-fix-strong-password-42!', displayName: 'grantee', role: 'user' });
    users.push(grantee.id);
    const actor: SkillActor = { userId: user.id, roles: ['user'] };
    const name = `fix-${randomUUID().slice(0, 8)}`;
    const created = await service.createDraft(actor, { name, description: 'review fixes' });
    const id = created.skill.id;
    skills.push(id);
    const revision = async () => (await repository.getSkill(id))!.revision;
    await service.saveDraft(actor, { skillId: id, expectedRevision: await revision(), skillMd: md(name) });
    const grants = [{ userId: grantee.id, permission: 'edit' as const }, { userId: grantee.id, permission: 'use' as const }];
    await service.setMetadata(actor, { skillId: id, expectedRevision: await revision(), grants });
    assert.deepEqual((await service.getManageDetail(actor, id)).grants, grants);
    await service.setMetadata(actor, { skillId: id, expectedRevision: await revision(), visibility: 'restricted' });
    assert.deepEqual((await service.getManageDetail(actor, id)).grants, grants);

    const save = (path: string, data: unknown) => revision().then(expectedRevision => service.saveFile(actor, { skillId: id, expectedRevision, path, bytes: bytes(data) }));
    const runtime = { schemaVersion: 1, runtimes: ['python3'], entrypoints: ['scripts/main.py'], requiredTools: [], network: 'none' };
    await save('scripts/main.py', 'print("ok")');
    await save('skill-runtime.json', runtime);
    assert.deepEqual((await repository.getVersion(id, 1))!.runtimeManifest, runtime);
    const unchanged = await revision();
    await assert.rejects(() => save('skill-runtime.json', '{bad-json'), /JSON/);
    assert.equal(await revision(), unchanged);
    await service.deleteDraftFile(actor, { skillId: id, expectedRevision: await revision(), path: 'skill-runtime.json' });
    assert.equal((await repository.getVersion(id, 1))!.runtimeManifest, null);
    await save('skill-runtime.json', runtime);
    await save('assets/A.txt', 'A');
    const beforeCollision = await revision();
    await assert.rejects(() => save('assets/a.txt', 'B'), /collision/i);
    assert.equal(await revision(), beforeCollision);
    assert.equal(await repository.getFile(id, 1, 'assets/a.txt'), null);

    await save('skill-runtime.json', { ...runtime, entrypoints: ['scripts/missing.py'] });
    await assert.rejects(async () => publishSkill(versionService, actor, { skillId: id, version: 1, expectedRevision: await revision() }), /Missing runtime entrypoint/);
    assert.equal((await repository.getSkill(id))!.publishedVersion, null);
    await save('skill-runtime.json', runtime);
    // Simulate a stale legacy JSONB cache: publication must use the real resource.
    await pool.query('UPDATE app_skill_versions SET runtime_manifest = NULL WHERE skill_id = $1 AND version = 1', [id]);
    const published = await publishSkill(versionService, actor, { skillId: id, version: 1, expectedRevision: await revision() });
    assert.deepEqual(published.version.runtimeManifest, runtime);
    await service.setEnabled(actor, { skillId: id, enabled: true, expectedRevision: await revision() });
    const context = (): SkillExecutionContext => ({ serverExecutionId: executionId, threadId: 'review-thread', auth: actor, pins: new Map() });
    const executionId = randomUUID();
    const brokenRepository = new Proxy(repository, { get(target, key) {
      if (key === 'upsertRunPin') return async () => { throw new Error('pin storage offline'); };
      return Reflect.get(target, key);
    } });
    const broken = createSkillService({ repository: brokenRepository, blobStore, releaseStore, versionService, pool });
    const rejected = context();
    assert.equal((await broken.load(rejected, name)).ok, false);
    assert.equal(rejected.pins.size, 0);
    const first = await service.load(context(), name);
    assert.equal(first.ok && first.skill.version, 1);
    const rows = await repository.listRunPins({ serverExecutionId: executionId, userId: actor.userId, threadId: 'review-thread' });
    assert.equal(rows[0]!.instructionsLoaded, true);
    const second = await service.createWorkingDraft(actor, { skillId: id, expectedRevision: await revision(), fromVersion: 1 });
    await service.deleteDraftFile(actor, { skillId: id, expectedRevision: await revision(), path: 'skill-runtime.json' });
    const noRuntime = await publishSkill(versionService, actor, { skillId: id, version: second.version.version, expectedRevision: await revision() });
    assert.equal(noRuntime.version.runtimeManifest, null);
    const again = await service.load(context(), name);
    assert.equal(again.ok && again.skill.version, 1, 'fresh context must adopt DB pin even after v2 was published');

    // A fresh RequestContext after compression/resume must restore real loads,
    // but not the many discovery pins produced by content search.
    const discoveryName = `discovery-${randomUUID().slice(0, 8)}`;
    const discovery = await service.createDraft(actor, { name: discoveryName, description: 'search only' });
    skills.push(discovery.skill.id);
    const savedDiscovery = await service.saveDraft(actor, { skillId: discovery.skill.id,
      expectedRevision: discovery.skill.revision, skillMd: md(discoveryName) + 'SEARCH_ONLY_MARKER' });
    const pubDiscovery = await publishSkill(versionService, actor, { skillId: discovery.skill.id,
      version: 1, expectedRevision: savedDiscovery.skill.revision });
    await service.setEnabled(actor, { skillId: discovery.skill.id, enabled: true, expectedRevision: pubDiscovery.skill.revision });
    const search = await service.search(context(), { query: 'no-match-at-all-983242' });
    assert.equal(search.ok, true);
    const rc = new RequestContext();
    rc.set('mastra__user', user);
    bindSkillServerExecutionId(rc, executionId);
    bindSkillThreadId(rc, 'review-thread');
    const processor = createSkillProcessor({ service, repository });
    const state = {};
    const previousEnabled = process.env.AGENT_SKILLS_ENABLED;
    process.env.AGENT_SKILLS_ENABLED = 'true';
    try {
      const response = await processor.processLLMRequest({ prompt: [{ role: 'user', content: 'continue' }],
        requestContext: rc, state, stepNumber: 1 } as never);
      const prompt = JSON.stringify(response);
      assert.match(prompt, /Instruction body/);
      assert.doesNotMatch(prompt, /SEARCH_ONLY_MARKER/);
    } finally {
      if (previousEnabled === undefined) delete process.env.AGENT_SKILLS_ENABLED;
      else process.env.AGENT_SKILLS_ENABLED = previousEnabled;
    }

    const limitsName = `limit-${randomUUID().slice(0, 8)}`;
    const limited = await repository.createDraft({ ownerUserId: actor.userId, canonicalName: limitsName, description: 'limits', skillMd: md(limitsName) });
    skills.push(limited.skill.id);
    const file = { path: 'a.bin', blobHash: 'a'.repeat(64), size: 80 * 1024 * 1024, isText: false };
    let current = await repository.upsertDraftFile({ skillId: limited.skill.id, actorUserId: actor.userId, expectedRevision: limited.skill.revision, file });
    current = await repository.upsertDraftFile({ skillId: limited.skill.id, actorUserId: actor.userId, expectedRevision: current.skill.revision, file: { ...file, path: 'b.bin' } });
    await assert.rejects(() => repository.upsertDraftFile({ skillId: limited.skill.id, actorUserId: actor.userId, expectedRevision: current.skill.revision, file: { ...file, path: 'c.bin' } }), /size|bytes/i);
    assert.equal((await repository.listFiles(limited.skill.id, 1)).length, 2);
    await assert.rejects(() => repository.updateDraft({ skillId: limited.skill.id, actorUserId: actor.userId, expectedRevision: current.skill.revision,
      files: Array.from({ length: SKILL_LIMITS.MAX_FILES }, (_, n) => ({ ...file, path: `assets/${n}`, size: 0 })) }), /files/i);
    assert.equal((await repository.listFiles(limited.skill.id, 1)).length, 2);
  } finally {
    if (skills.length) {
      await pool.query('UPDATE app_skills SET published_version = NULL WHERE id = ANY($1::uuid[])', [skills]);
      for (const table of ['app_skill_run_pins', 'app_skill_events', 'app_skill_shortcuts', 'app_skill_sync_sessions', 'app_skill_grants', 'app_skill_audience_grants', 'app_skill_aliases', 'app_skill_files', 'app_skill_versions']) {
        await pool.query(`DELETE FROM ${table} WHERE skill_id = ANY($1::uuid[])`, [skills]);
      }
      await pool.query('DELETE FROM app_skills WHERE id = ANY($1::uuid[])', [skills]);
    }
    for (const id of users) await pool.query('DELETE FROM app_users WHERE id = $1', [id]);
    await rm(root, { recursive: true, force: true });
    await pool.end();
  }
});
