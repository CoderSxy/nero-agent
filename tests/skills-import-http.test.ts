/**
 * Task 12: import/export/sync HTTP using the Task 1 package validator.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
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
import { hashSkillBytes } from '../src/mastra/skills/sync.ts';
import type { SkillActor } from '../src/mastra/skills/types.ts';
import { SKILL_LIMITS } from '../src/mastra/skills/validation.ts';
import { createSkillVersionService, publishSkill } from '../src/mastra/skills/versions.ts';

const MASTRA_USER_KEY = 'mastra__user';

function resolveSafeTestDatabaseUrl(): { ok: true } | { ok: false; reason: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL unset; skills import HTTP skipped' };
  try {
    const parsed = new URL(raw);
    const hostOk = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    const portOk = parsed.port === '5433';
    const dbOk = parsed.pathname.replace(/^\//, '') === 'nero_agent';
    if (!hostOk || !portOk || !dbOk) {
      return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL is not 127.0.0.1|localhost:5433/nero_agent' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL is not a valid URL' };
  }
}

const safeDb = resolveSafeTestDatabaseUrl();

test('skills import HTTP env gate documents BLOCKED_ENV when DB is unsafe or missing', () => {
  if (safeDb.ok) return;
  assert.match(safeDb.reason, /^BLOCKED_ENV:/);
  console.log(safeDb.reason);
});

function skillMd(name: string, description: string, body = 'body\n'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function buildZip(entries: Array<{ path: string; text: string }>): Promise<Uint8Array> {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  for (const entry of entries) {
    await writer.add(entry.path, new Uint8ArrayReader(utf8(entry.text)));
  }
  const blob = await writer.close();
  return new Uint8Array(await blob.arrayBuffer());
}

function buildApp(routes: ApiRoute[], usersByToken: Map<string, AuthUser>) {
  const app = new Hono();
  for (const route of routes) {
    if (!('handler' in route) || !route.handler) throw new Error(`route ${route.path} has no handler`);
    const handler = route.handler;
    app.on(route.method, route.path, async (c, next) => {
      const requestContext = new RequestContext();
      c.set('requestContext', requestContext);
      const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? '';
      const authed = usersByToken.get(token);
      if (!authed) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Unauthorized' } }, 401);
      requestContext.set(MASTRA_USER_KEY, authed);
      return handler(c, next);
    });
  }
  return app;
}

test('HTTP zip rejection, alias conflict, locked published name, export-import-sync loop', { skip: !safeDb.ok }, async () => {
  const prevEnabled = process.env.AGENT_SKILLS_ENABLED;
  const prevTemp = process.env.SKILLS_IMPORT_TEMP_ROOT;
  process.env.AGENT_SKILLS_ENABLED = 'true';
  const tempRoot = await mkdtemp(join(tmpdir(), 'skills-import-http-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'skills-import-store-'));
  process.env.SKILLS_IMPORT_TEMP_ROOT = tempRoot;
  const pool = getPool();
  const suffix = randomUUID().slice(0, 8);
  const userA = await createUser({
    email: `imp-a-${suffix}@example.test`,
    displayName: `ImpA ${suffix}`,
    password: 'test-password-a',
    role: 'user',
  });
  const userB = await createUser({
    email: `imp-b-${suffix}@example.test`,
    displayName: `ImpB ${suffix}`,
    password: 'test-password-b',
    role: 'user',
  });
  const actorA: SkillActor = { userId: userA.id, roles: ['user'] };
  const repo = createSkillRepository(pool);
  const blobStore = createBlobStore({ root: storageRoot });
  const releaseStore = createReleaseStore({ root: storageRoot, blobStore });
  const versions = createSkillVersionService({ repository: repo, blobStore, releaseStore, pool });
  const service = createSkillService({ repository: repo, blobStore, releaseStore, versionService: versions, pool });
  const app = buildApp(createSkillRoutes(() => service), new Map([['a', userA], ['b', userB]]));

  const call = async (method: string, path: string, token: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return app.request(path, { ...init, method, headers });
  };

  const name = `imp-demo-${suffix}`;
  const description = 'Import HTTP round-trip skill.';
  const md = skillMd(name, description, 'round-trip\n');
  const created = await service.createDraft(actorA, { name, description, skillMd: md, alias: `alias.${suffix}` });
  const saved = await service.saveFile(actorA, {
    skillId: created.skill.id,
    expectedRevision: created.skill.revision,
    path: 'references/note.txt',
    bytes: utf8('hello-export'),
  });

  try {
    const tooBig = await call('POST', '/agent-skills/imports/preview', 'a', {
      headers: { 'content-type': 'application/zip', 'content-length': String(SKILL_LIMITS.ZIP_MAX_BYTES + 1) },
      body: Buffer.from('x'),
    });
    assert.equal(tooBig.status, 413);

    const valid = await buildZip([
      { path: 'SKILL.md', text: md },
      { path: 'references/note.txt', text: 'hello-export' },
    ]);
    const truncated = await call('POST', '/agent-skills/imports/preview', 'a', {
      headers: { 'content-type': 'application/zip' },
      body: Buffer.from(valid.subarray(0, 24)),
    });
    assert.equal(truncated.status, 422);
    const truncatedBody = await truncated.json() as { error: { code: string } };
    assert.equal(truncatedBody.error.code, 'ZIP_INVALID');

    const corrupt = new Uint8Array(valid);
    const nameLen = corrupt[26]! | (corrupt[27]! << 8);
    const extraLen = corrupt[28]! | (corrupt[29]! << 8);
    const dataAt = 30 + nameLen + extraLen;
    corrupt[dataAt] ^= 0xff;
    const crc = await call('POST', '/agent-skills/imports/preview', 'a', {
      headers: { 'content-type': 'application/zip' },
      body: Buffer.from(corrupt),
    });
    assert.equal(crc.status, 422);
    const crcBody = await crc.json() as { error: { code: string } };
    assert.equal(crcBody.error.code, 'ZIP_INVALID');

    const collisionZip = await buildZip([
      { path: 'SKILL.md', text: md },
      { path: 'references/A.txt', text: 'A' },
      { path: 'references/a.txt', text: 'a' },
    ]);
    const collision = await call('POST', '/agent-skills/imports/preview', 'a', {
      headers: { 'content-type': 'application/zip' },
      body: Buffer.from(collisionZip),
    });
    assert.equal(collision.status, 422);
    const collisionBody = await collision.json() as { error: { code: string } };
    assert.equal(collisionBody.error.code, 'PATH_COLLISION');

    const otherName = `imp-other-${suffix}`;
    const otherMd = skillMd(otherName, description, 'other\n');
    const aliasZip = await buildZip([{ path: 'SKILL.md', text: otherMd }]);
    const aliasForm = new FormData();
    aliasForm.set('file', new File([aliasZip], 'alias.zip', { type: 'application/zip' }));
    const aliasPreview = await call('POST', '/agent-skills/imports/preview', 'a', { body: aliasForm });
    assert.equal(aliasPreview.status, 200);
    const aliasPreviewBody = await aliasPreview.json() as { importId: string };
    const aliasCommit = await call('POST', `/agent-skills/imports/${aliasPreviewBody.importId}/commit`, 'a', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ acceptedName: otherName, alias: `alias.${suffix}` }),
    });
    assert.equal(aliasCommit.status, 409);
    const aliasBody = await aliasCommit.json() as { error: { code: string } };
    assert.equal(aliasBody.error.code, 'NAME_CONFLICT');

    const published = await publishSkill(versions, actorA, {
      skillId: created.skill.id,
      version: saved.version.version,
      expectedRevision: saved.skill.revision,
      remark: 'v1',
    });
    const enabled = await service.setEnabled(actorA, {
      skillId: created.skill.id,
      expectedRevision: published.skill.revision,
      enabled: true,
    });
    await pool.query(
      `INSERT INTO app_skill_grants (skill_id, user_id, permission) VALUES ($1, $2, 'use')`,
      [created.skill.id, userB.id],
    );
    const useExport = await call('GET', `/agent-skills/${created.skill.id}/export?version=${published.version.version}`, 'b');
    assert.equal(useExport.status, 200);
    const useDenied = await call('GET', `/agent-skills/${created.skill.id}/export?version=99`, 'b');
    assert.equal(useDenied.status, 404);

    const draft = await service.createWorkingDraft(actorA, {
      skillId: created.skill.id,
      expectedRevision: enabled.revision,
    });
    const maintainerHistory = await call('GET', `/agent-skills/${created.skill.id}/export?version=${draft.version.version}`, 'a');
    assert.equal(maintainerHistory.status, 200);
    const useHistory = await call('GET', `/agent-skills/${created.skill.id}/export?version=${draft.version.version}`, 'b');
    assert.equal(useHistory.status, 404);

    const renamed = `imp-renamed-${suffix}`;
    const renameZip = await buildZip([{ path: 'SKILL.md', text: skillMd(renamed, description, 'nope\n') }]);
    const renameForm = new FormData();
    renameForm.set('file', new File([renameZip], 'rename.zip', { type: 'application/zip' }));
    const renamePreview = await call('POST', '/agent-skills/imports/preview', 'a', { body: renameForm });
    assert.equal(renamePreview.status, 200);
    const renameBody = await renamePreview.json() as { importId: string; report: { referenceRenameRisks: unknown[] } };
    const renameCommit = await call('POST', `/agent-skills/imports/${renameBody.importId}/commit`, 'a', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        acceptedName: renamed,
        targetSkillId: created.skill.id,
        expectedRevision: draft.skill.revision,
      }),
    });
    assert.equal(renameCommit.status, 409);
    const renameErr = await renameCommit.json() as { error: { code: string } };
    assert.equal(renameErr.error.code, 'NAME_LOCKED');

    const exported = await call('GET', `/agent-skills/${created.skill.id}/export?version=${published.version.version}`, 'a');
    assert.equal(exported.status, 200);
    const exportedBytes = new Uint8Array(await exported.arrayBuffer());
    await service.saveFile(actorA, {
      skillId: created.skill.id,
      expectedRevision: draft.skill.revision,
      path: 'references/note.txt',
      bytes: utf8('edited-away'),
    });
    const detailAfterEdit = await service.getManageDetail(actorA, created.skill.id);
    const importForm = new FormData();
    importForm.set('file', new File([exportedBytes], 'export.zip', { type: 'application/zip' }));
    const reimport = await call('POST', '/agent-skills/imports/preview', 'a', { body: importForm });
    assert.equal(reimport.status, 200);
    const reimportBody = await reimport.json() as { importId: string };
    const restored = await call('POST', `/agent-skills/imports/${reimportBody.importId}/commit`, 'a', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        acceptedName: name,
        targetSkillId: created.skill.id,
        expectedRevision: detailAfterEdit.skill.revision,
      }),
    });
    assert.equal(restored.status, 201);
    const restoredBody = await restored.json() as { skill: { enabled: boolean; publishedVersion: number | null; revision: string }; version: { skillMd: string; version: number } };
    assert.equal(restoredBody.skill.enabled, true);
    assert.equal(restoredBody.version.skillMd, md);
    const restoredFile = await repo.getFile(created.skill.id, restoredBody.version.version, 'references/note.txt');
    assert.equal(restoredFile?.blobHash, hashSkillBytes(utf8('hello-export')));

    const syncZip = await buildZip([
      { path: 'SKILL.md', text: md },
      { path: 'references/note.txt', text: 'synced-edit' },
    ]);
    const syncForm = new FormData();
    syncForm.set('file', new File([syncZip], 'sync.zip', { type: 'application/zip' }));
    syncForm.set('expectedRevision', restoredBody.skill.revision);
    const syncPreview = await call('POST', `/agent-skills/${created.skill.id}/sync/preview`, 'a', { body: syncForm });
    assert.equal(syncPreview.status, 200);
    const syncBody = await syncPreview.json() as {
      syncId: string;
      diff: { entries: Array<{ path: string; kind: string; selected: boolean }> };
    };
    const note = syncBody.diff.entries.find((entry) => entry.path === 'references/note.txt');
    assert.equal(note?.kind, 'modify');
    assert.equal(note?.selected, true);
    const syncCommit = await call('POST', `/agent-skills/${created.skill.id}/sync/${syncBody.syncId}/commit`, 'a', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: restoredBody.skill.revision,
        selectedPaths: ['references/note.txt'],
        includeDeletes: false,
      }),
    });
    assert.equal(syncCommit.status, 200);
    const synced = await syncCommit.json() as { version: { version: number }; skill: { enabled: boolean } };
    assert.equal(synced.skill.enabled, true);
    const syncedFile = await repo.getFile(created.skill.id, synced.version.version, 'references/note.txt');
    assert.equal(syncedFile?.blobHash, hashSkillBytes(utf8('synced-edit')));
    const stillPublished = await service.getManageDetail(actorA, created.skill.id);
    assert.equal(stillPublished.skill.publishedVersion, published.version.version);
    assert.notEqual(stillPublished.draft?.version, published.version.version);
  } finally {
    if (prevEnabled === undefined) delete process.env.AGENT_SKILLS_ENABLED;
    else process.env.AGENT_SKILLS_ENABLED = prevEnabled;
    if (prevTemp === undefined) delete process.env.SKILLS_IMPORT_TEMP_ROOT;
    else process.env.SKILLS_IMPORT_TEMP_ROOT = prevTemp;
    await rm(tempRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
});
