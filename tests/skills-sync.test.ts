/**
 * Task 12: draft diff, selective sync, import sessions (30 min, actor-bound).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { getPool } from '../src/mastra/auth/db.ts';
import { createUser } from '../src/mastra/auth/service.ts';
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import { SkillRepositoryError, SkillSyncError } from '../src/mastra/skills/errors.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';
import { createSkillRepository } from '../src/mastra/skills/repository.ts';
import { createSkillService } from '../src/mastra/skills/service.ts';
import { diffSkillTrees, hashSkillBytes, createSkillSyncApi } from '../src/mastra/skills/sync.ts';
import type { SkillActor } from '../src/mastra/skills/types.ts';
import { createSkillVersionService } from '../src/mastra/skills/versions.ts';

function resolveSafeTestDatabaseUrl(): { ok: true } | { ok: false; reason: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL unset; skills sync tests skipped' };
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

test('diffSkillTrees marks add, modify, delete, and unchanged; deletes start unselected', () => {
  const entries = diffSkillTrees(
    [
      { path: 'SKILL.md', hash: 'same' },
      { path: 'references/keep.txt', hash: 'old' },
      { path: 'references/gone.txt', hash: 'g' },
    ],
    [
      { path: 'SKILL.md', hash: 'same' },
      { path: 'references/keep.txt', hash: 'new' },
      { path: 'references/added.txt', hash: 'a' },
    ],
  );
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get('references/added.txt')?.kind, 'add');
  assert.equal(byPath.get('references/added.txt')?.selected, true);
  assert.equal(byPath.get('references/keep.txt')?.kind, 'modify');
  assert.equal(byPath.get('references/keep.txt')?.baseHash, 'old');
  assert.equal(byPath.get('references/keep.txt')?.incomingHash, 'new');
  assert.equal(byPath.get('references/gone.txt')?.kind, 'delete');
  assert.equal(byPath.get('references/gone.txt')?.selected, false);
  assert.equal(byPath.get('SKILL.md')?.kind, 'unchanged');
  assert.equal(byPath.get('SKILL.md')?.selected, false);
});

test('skills sync env gate documents BLOCKED_ENV when DB is unsafe or missing', () => {
  if (safeDb.ok) {
    assert.equal(safeDb.ok, true);
    return;
  }
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

function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from([Buffer.from(bytes)])) as ReadableStream<Uint8Array>;
}

test('sync sessions: selective commit, 409, 410, stolen id 404, revoke, atomic draft', { skip: !safeDb.ok }, async () => {
  const prevTemp = process.env.SKILLS_IMPORT_TEMP_ROOT;
  const prevStorage = process.env.SKILLS_STORAGE_ROOT;
  const tempRoot = await mkdtemp(join(tmpdir(), 'skills-sync-temp-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'skills-sync-store-'));
  process.env.SKILLS_IMPORT_TEMP_ROOT = tempRoot;
  const pool = getPool();
  const suffix = randomUUID().slice(0, 8);
  const owner = await createUser({
    email: `sync-owner-${suffix}@example.test`,
    displayName: `SyncOwner ${suffix}`,
    password: 'test-password-owner',
    role: 'user',
  });
  const other = await createUser({
    email: `sync-other-${suffix}@example.test`,
    displayName: `SyncOther ${suffix}`,
    password: 'test-password-other',
    role: 'user',
  });
  const editor = await createUser({
    email: `sync-editor-${suffix}@example.test`,
    displayName: `SyncEditor ${suffix}`,
    password: 'test-password-editor',
    role: 'user',
  });
  const actor: SkillActor = { userId: owner.id, roles: ['user'] };
  const otherActor: SkillActor = { userId: other.id, roles: ['user'] };
  const editorActor: SkillActor = { userId: editor.id, roles: ['user'] };
  const repo = createSkillRepository(pool);
  const blobStore = createBlobStore({ root: storageRoot });
  const releaseStore = createReleaseStore({ root: storageRoot, blobStore });
  const versions = createSkillVersionService({ repository: repo, blobStore, releaseStore, pool });
  const service = createSkillService({ repository: repo, blobStore, releaseStore, versionService: versions, pool });
  const name = `sync-demo-${suffix}`;
  const description = 'Sync session skill for selective draft updates.';
  const created = await service.createDraft(actor, {
    name,
    description,
    skillMd: skillMd(name, description, 'original\n'),
  });
  const withFile = await service.saveFile(actor, {
    skillId: created.skill.id,
    expectedRevision: created.skill.revision,
    path: 'references/keep.txt',
    bytes: utf8('keep-v1'),
  });
  const gone = await service.saveFile(actor, {
    skillId: created.skill.id,
    expectedRevision: withFile.skill.revision,
    path: 'references/gone.txt',
    bytes: utf8('gone-v1'),
  });

  try {
    const zip = await buildZip([
      { path: 'SKILL.md', text: skillMd(name, description, 'original\n') },
      { path: 'references/keep.txt', text: 'keep-v2' },
      { path: 'references/added.txt', text: 'added-v1' },
    ]);
    const preview = await service.previewSync(actor, {
      skillId: created.skill.id,
      expectedRevision: gone.skill.revision,
      stream: streamFrom(zip),
    });
    const kinds = new Map(preview.diff.entries.map((entry) => [entry.path, entry]));
    assert.equal(kinds.get('references/added.txt')?.kind, 'add');
    assert.equal(kinds.get('references/keep.txt')?.kind, 'modify');
    assert.equal(kinds.get('references/gone.txt')?.kind, 'delete');
    assert.equal(kinds.get('references/gone.txt')?.selected, false);
    assert.equal(kinds.get('SKILL.md')?.kind, 'unchanged');
    assert.equal(kinds.get('SKILL.md')?.selected, false);

    const onlyAdd = await service.commitSync(actor, {
      skillId: created.skill.id,
      syncId: preview.syncId,
      expectedRevision: gone.skill.revision,
      selectedPaths: ['references/added.txt'],
      includeDeletes: false,
    });
    const afterAdd = await repo.listFiles(created.skill.id, onlyAdd.version.version);
    const added = afterAdd.find((file) => file.path === 'references/added.txt');
    const keep = afterAdd.find((file) => file.path === 'references/keep.txt');
    const removed = afterAdd.find((file) => file.path === 'references/gone.txt');
    assert.ok(added);
    assert.equal(added.blobHash, hashSkillBytes(utf8('added-v1')));
    assert.equal(keep?.blobHash, hashSkillBytes(utf8('keep-v1')));
    assert.ok(removed, 'unselected delete must remain');

    const zip2 = await buildZip([
      { path: 'SKILL.md', text: skillMd(name, description, 'original\n') },
      { path: 'references/keep.txt', text: 'keep-v2' },
      { path: 'references/added.txt', text: 'added-v1' },
    ]);
    const preview2 = await service.previewSync(actor, {
      skillId: created.skill.id,
      expectedRevision: onlyAdd.skill.revision,
      stream: streamFrom(zip2),
    });
    await assert.rejects(
      () => service.commitSync(actor, {
        skillId: created.skill.id,
        syncId: preview2.syncId,
        expectedRevision: onlyAdd.skill.revision,
        selectedPaths: ['references/not-in-diff.txt'],
        includeDeletes: false,
      }),
      (err: unknown) => err instanceof SkillSyncError && err.status === 400 && err.code === 'PATH_NOT_IN_DIFF',
    );

    const edited = await service.saveDraft(actor, {
      skillId: created.skill.id,
      expectedRevision: onlyAdd.skill.revision,
      skillMd: skillMd(name, description, 'concurrent\n'),
    });
    assert.notEqual(edited.skill.revision, onlyAdd.skill.revision);
    await assert.rejects(
      () => service.commitSync(actor, {
        skillId: created.skill.id,
        syncId: preview2.syncId,
        expectedRevision: onlyAdd.skill.revision,
        selectedPaths: ['references/keep.txt'],
        includeDeletes: false,
      }),
      (err: unknown) => err instanceof SkillRepositoryError && err.status === 409,
    );
    const keepAfterConflict = await repo.getFile(created.skill.id, onlyAdd.version.version, 'references/keep.txt');
    assert.equal(keepAfterConflict?.blobHash, hashSkillBytes(utf8('keep-v1')));

    const zip3 = await buildZip([
      { path: 'SKILL.md', text: skillMd(name, description, 'concurrent\n') },
      { path: 'references/keep.txt', text: 'keep-v1' },
      { path: 'references/gone.txt', text: 'gone-v1' },
      { path: 'references/added.txt', text: 'added-v1' },
    ]);
    const preview3 = await service.previewSync(actor, {
      skillId: created.skill.id,
      expectedRevision: edited.skill.revision,
      stream: streamFrom(zip3),
    });
    await pool.query(
      `UPDATE app_skill_sync_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [preview3.syncId],
    );
    await assert.rejects(
      () => service.commitSync(actor, {
        skillId: created.skill.id,
        syncId: preview3.syncId,
        expectedRevision: edited.skill.revision,
        selectedPaths: [],
        includeDeletes: false,
      }),
      (err: unknown) => err instanceof SkillSyncError && err.status === 410,
    );

    const preview4 = await service.previewSync(actor, {
      skillId: created.skill.id,
      expectedRevision: edited.skill.revision,
      stream: streamFrom(zip3),
    });
    await assert.rejects(
      () => service.commitSync(otherActor, {
        skillId: created.skill.id,
        syncId: preview4.syncId,
        expectedRevision: edited.skill.revision,
        selectedPaths: [],
        includeDeletes: false,
      }),
      (err: unknown) => err instanceof SkillSyncError && err.status === 404,
    );

    await pool.query(
      `INSERT INTO app_skill_grants (skill_id, user_id, permission) VALUES ($1, $2, 'edit')`,
      [created.skill.id, editor.id],
    );
    const preview5 = await service.previewSync(editorActor, {
      skillId: created.skill.id,
      expectedRevision: edited.skill.revision,
      stream: streamFrom(zip3),
    });
    await pool.query(
      `DELETE FROM app_skill_grants WHERE skill_id = $1 AND user_id = $2 AND permission = 'edit'`,
      [created.skill.id, editor.id],
    );
    await assert.rejects(
      () => service.commitSync(editorActor, {
        skillId: created.skill.id,
        syncId: preview5.syncId,
        expectedRevision: edited.skill.revision,
        selectedPaths: ['references/keep.txt'],
        includeDeletes: false,
      }),
      (err: unknown) => err instanceof Error && 'status' in err && (err as { status: number }).status === 403,
    );

    const freshName = `sync-atomic-${suffix}`;
    const fresh = await service.createDraft(actor, {
      name: freshName,
      description,
      skillMd: skillMd(freshName, description, 'stay\n'),
    });
    const seeded = await service.saveFile(actor, {
      skillId: fresh.skill.id,
      expectedRevision: fresh.skill.revision,
      path: 'references/keep.txt',
      bytes: utf8('stay-put'),
    });
    const importZip = await buildZip([
      { path: 'SKILL.md', text: skillMd(freshName, description, 'replaced\n') },
      { path: 'references/new.txt', text: 'should-not-land' },
    ]);
    const syncApi = createSkillSyncApi({
      repository: repo,
      blobStore,
      beforeSessionConsume: async () => {
        throw new Error('boom-before-consume');
      },
    });
    const imported = await syncApi.previewImport(actor, streamFrom(importZip));
    assert.equal(imported.report.referenceRenameRisks.length, 0);
    await assert.rejects(
      () => syncApi.commitImport(actor, {
        importId: imported.importId,
        acceptedName: freshName,
        targetSkillId: fresh.skill.id,
        expectedRevision: seeded.skill.revision,
      }),
      /boom-before-consume/,
    );
    const still = await repo.listFiles(fresh.skill.id, seeded.version.version);
    assert.deepEqual(still.map((file) => file.path), ['references/keep.txt']);
    const detail = await service.getManageDetail(actor, fresh.skill.id);
    assert.match(detail.draft?.skillMd ?? '', /stay/);
    assert.equal(detail.skill.enabled, false);
    assert.equal(detail.skill.publishedVersion, null);
    const session = await pool.query<{ status: string }>(
      `SELECT status FROM app_skill_sync_sessions WHERE id = $1`,
      [imported.importId],
    );
    assert.equal(session.rows[0]?.status, 'pending');
  } finally {
    if (prevTemp === undefined) delete process.env.SKILLS_IMPORT_TEMP_ROOT;
    else process.env.SKILLS_IMPORT_TEMP_ROOT = prevTemp;
    if (prevStorage === undefined) delete process.env.SKILLS_STORAGE_ROOT;
    else process.env.SKILLS_STORAGE_ROOT = prevStorage;
    await rm(tempRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
});
