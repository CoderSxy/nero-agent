import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Uint8ArrayWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { getPool } from '../src/mastra/auth/db';
import { createUser } from '../src/mastra/auth/service';
import { createBlobStore } from '../src/mastra/skills/blob-store';
import { createReleaseStore } from '../src/mastra/skills/release-store';
import { createSkillRepository } from '../src/mastra/skills/repository';
import { createSkillService } from '../src/mastra/skills/service';
import { createSkillVersionService } from '../src/mastra/skills/versions';
import { createReadinessChecker } from '../src/mastra/skills/readiness';
let localDatabase = false;
try { const url = new URL(process.env.DATABASE_URL ?? ''); localDatabase = ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '5433' && url.pathname === '/nero_agent'; } catch {}

test('real DB import → check → publish gate → enable/load; failed next version retains old pointer and permissions', { skip: !localDatabase }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-readiness-flow-'));
  const previousTemp = process.env.SKILLS_IMPORT_TEMP_ROOT;
  process.env.SKILLS_IMPORT_TEMP_ROOT = root;
  const pool = getPool();
  const repo = createSkillRepository(pool), blobs = createBlobStore({ root }), releases = createReleaseStore({ root, blobStore: blobs });
  let missing = true, probes = 0;
  const checker = createReadinessChecker({ environment: () => ({ fingerprint: 'test-image', enabled: true, scriptEnabled: true, publicNetwork: false }), probe: async () => { probes++; return [{ kind: 'python', name: 'python-pptx', status: missing ? 'missing' : 'ok', message: missing ? '缺少 python-pptx' : 'python-pptx 可用' }]; } });
  const versions = createSkillVersionService({ repository: repo, blobStore: blobs, releaseStore: releases, pool, readiness: checker });
  const service = createSkillService({ repository: repo, blobStore: blobs, releaseStore: releases, versionService: versions, pool, readiness: checker });
  const users: string[] = []; let id: string | undefined;
  try {
    const owner = await createUser({ email: `readiness-${randomUUID()}@test.invalid`, password: 'readiness-test-password', displayName: 'readiness', role: 'user' }); users.push(owner.id);
    const other = await createUser({ email: `readiness-${randomUUID()}@test.invalid`, password: 'readiness-test-password', displayName: 'other', role: 'user' }); users.push(other.id);
    const actor = { userId: owner.id, roles: ['user'] };
    const name = `readiness-${randomUUID().slice(0, 8)}`;
    const writer = new ZipWriter(new Uint8ArrayWriter());
    const runtime = { schemaVersion: 2, runtimes: ['python3'], entrypoints: ['scripts/main.py'], requiredTools: [], network: 'none', dependencies: { python: [{ name: 'python-pptx' }] } };
    for (const [path, text] of Object.entries({ 'SKILL.md': `---\nname: ${name}\ndescription: readiness integration\n---\nGenerate a deck.`, 'scripts/main.py': 'print("not executed by checks")', 'skill-runtime.json': JSON.stringify(runtime) })) await writer.add(path, new Uint8ArrayReader(Buffer.from(text)));
    const zip = await writer.close();
    const preview = await service.previewImport(actor, Readable.toWeb(Readable.from([zip])) as ReadableStream<Uint8Array>);
    assert.equal(preview.report.readiness?.status, 'blocked');
    const created = await service.commitImport(actor, { importId: preview.importId, acceptedName: name }); id = created.skill.id;
    assert.equal(created.skill.enabled, false);
    await assert.rejects(() => service.checkRuntime({ userId: other.id, roles: ['user'] }, id!, 1));
    const input = { skillId: id, version: 1, expectedRevision: created.skill.revision };
    await assert.rejects(() => service.publish(actor, input), { code: 'RUNTIME_NOT_READY' });
    assert.equal((await repo.getSkill(id))!.publishedVersion, null);
    missing = false;
    assert.equal((await service.checkRuntime(actor, id, 1, true)).status, 'ready');
    const published = await service.publish(actor, input);
    const enabled = await service.setEnabled(actor, { skillId: id, enabled: true, expectedRevision: published.skill.revision });
    assert.ok((await service.listAvailable(actor, { page: 1, pageSize: 20 })).items.some(item => item.id === id));
    const draft = await service.createWorkingDraft(actor, { skillId: id, expectedRevision: enabled.revision });
    missing = true;
    await assert.rejects(() => service.publish(actor, { skillId: id!, version: draft.version.version, expectedRevision: draft.skill.revision }), { code: 'RUNTIME_NOT_READY' });
    assert.equal((await repo.getSkill(id))!.publishedVersion, 1);
    assert.ok(probes >= 4);
  } finally {
    if (id) {
      await pool.query('UPDATE app_skills SET published_version=NULL WHERE id=$1', [id]);
      for (const table of ['app_skill_sync_sessions', 'app_skill_events', 'app_skill_files', 'app_skill_versions', 'app_skill_aliases', 'app_skill_grants', 'app_skill_audience_grants']) await pool.query(`DELETE FROM ${table} WHERE skill_id=$1`, [id]);
      await pool.query('DELETE FROM app_skills WHERE id=$1', [id]);
    }
    for (const userId of users) { await pool.query('DELETE FROM app_skill_sync_sessions WHERE actor_user_id=$1', [userId]); await pool.query('DELETE FROM app_users WHERE id=$1', [userId]); }
    if (previousTemp === undefined) delete process.env.SKILLS_IMPORT_TEMP_ROOT; else process.env.SKILLS_IMPORT_TEMP_ROOT = previousTemp;
    await rm(root, { recursive: true, force: true }); await pool.end();
  }
});
