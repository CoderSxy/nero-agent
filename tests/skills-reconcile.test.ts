/**
 * Task 14: release reconcile + GC (dry-run default, 7d grace).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';
import {
  SKILL_AUDIT_RUN_RETENTION_MS,
  SKILL_GC_GRACE_MS,
  SKILL_RUN_PIN_ENDED_GRACE_MS,
  collectSkillStorageInventory,
  planSkillGarbage,
  reconcileOrphanSkillContainers,
  reconcileSkills,
  runSkillGc,
  type SkillGcInventory,
} from '../src/mastra/skills/reconcile.ts';
import type { SkillManifestEntry } from '../src/mastra/skills/types.ts';
import { parseGcArgs } from '../scripts/skills-gc.ts';

const DAY = 24 * 60 * 60 * 1000;

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('GC grace is 7 days, run pins end+7d, audit run events 90 days', () => {
  assert.equal(SKILL_GC_GRACE_MS, 7 * DAY);
  assert.equal(SKILL_RUN_PIN_ENDED_GRACE_MS, 7 * DAY);
  assert.equal(SKILL_AUDIT_RUN_RETENTION_MS, 90 * DAY);
});

test('skills-gc defaults to dry-run; --apply is explicit', () => {
  assert.equal(parseGcArgs([]).apply, false);
  assert.equal(parseGcArgs(['--apply']).apply, true);
});

test('missing release rebuilds from trusted blobs; bad blob is 503 and does not switch version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-reconcile-'));
  try {
    const blobs = createBlobStore({ root });
    const release = createReleaseStore({ root, blobStore: blobs });
    const skillMd = '---\nname: demo\ndescription: d\n---\n\n# Demo\n';
    const refBytes = Buffer.from('reference body\n', 'utf8');
    const refPut = await blobs.put(Readable.from([refBytes]), 1024);
    const entries: SkillManifestEntry[] = [{
      path: 'references/note.md',
      blobHash: refPut.hash,
      size: refPut.size,
      isText: true,
    }];
    const materialized = await release.materialize('skill-a', 1, {
      skillId: 'skill-a',
      version: 1,
      skillMd,
      entries,
    });
    const pointer = { version: 1, manifestHash: materialized.manifestHash };
    await rm(materialized.releaseRoot, { recursive: true, force: true });

    const rebuilt = await reconcileSkills({ dryRun: false }, {
      listCurrentPublished: async () => [{
        skillId: 'skill-a',
        version: pointer.version,
        manifestHash: pointer.manifestHash,
        skillMd,
        entries,
      }],
      releaseStore: release,
      markUnavailable: async () => {
        throw new Error('good blobs must not mark unavailable');
      },
    });
    assert.equal(rebuilt.rebuilt.length, 1);
    assert.equal(rebuilt.unavailable.length, 0);
    assert.equal(pointer.version, 1);
    const restored = await readFile(join(materialized.releaseRoot, 'SKILL.md'), 'utf8');
    assert.equal(restored, skillMd);
    const ref = await readFile(join(materialized.releaseRoot, 'references/note.md'));
    assert.equal(ref.toString('utf8'), refBytes.toString('utf8'));

    await rm(materialized.releaseRoot, { recursive: true, force: true });
    await writeFile(join(root, 'blobs', refPut.hash), Buffer.from('tampered', 'utf8'));
    const marked: Array<{ code: string; status: number; version: number }> = [];
    const failed = await reconcileSkills({ dryRun: false }, {
      listCurrentPublished: async () => [{
        skillId: 'skill-a',
        version: pointer.version,
        manifestHash: pointer.manifestHash,
        skillMd,
        entries,
      }],
      releaseStore: release,
      markUnavailable: async (target, error) => {
        marked.push({ code: error.code, status: error.status, version: target.version });
      },
    });
    assert.equal(failed.rebuilt.length, 0);
    assert.equal(marked.length, 1);
    assert.equal(marked[0]!.code, 'BLOB_HASH_MISMATCH');
    assert.equal(marked[0]!.status, 503);
    assert.equal(pointer.version, 1);
    await assert.rejects(() => stat(materialized.releaseRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dry-run reconcile does not rebuild a missing release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-reconcile-dry-'));
  try {
    const blobs = createBlobStore({ root });
    const release = createReleaseStore({ root, blobStore: blobs });
    const skillMd = '---\nname: demo\ndescription: d\n---\n\n# Dry\n';
    const materialized = await release.materialize('skill-b', 2, {
      skillId: 'skill-b',
      version: 2,
      skillMd,
      entries: [],
    });
    await rm(materialized.releaseRoot, { recursive: true, force: true });
    const report = await reconcileSkills({ dryRun: true }, {
      listCurrentPublished: async () => [{
        skillId: 'skill-b',
        version: 2,
        manifestHash: materialized.manifestHash,
        skillMd,
        entries: [],
      }],
      releaseStore: release,
      markUnavailable: async () => {
        throw new Error('dry-run must not mark unavailable');
      },
    });
    assert.equal(report.dryRun, true);
    assert.equal(report.wouldRebuild.length, 1);
    assert.equal(report.rebuilt.length, 0);
    await assert.rejects(() => stat(materialized.releaseRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two reconciles do not delete each other staging or the current release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-reconcile-race-'));
  try {
    const blobs = createBlobStore({ root });
    const gate = deferred();
    let arm = false;
    const release = createReleaseStore({
      root,
      blobStore: blobs,
      hooks: {
        beforeReleaseRename: async (stagingRoot) => {
          if (!arm) return;
          const peer = join(root, 'releases', 'skill-c', '1', '.staging-peer', 'KEEP');
          const peerStat = await stat(peer);
          assert.equal(peerStat.isFile(), true);
          const own = await stat(join(stagingRoot, 'SKILL.md'));
          assert.equal(own.isFile(), true);
          await gate.promise;
        },
      },
    });
    const skillMd = '---\nname: demo\ndescription: d\n---\n\n# Race\n';
    const materialized = await release.materialize('skill-c', 1, {
      skillId: 'skill-c',
      version: 1,
      skillMd,
      entries: [],
    });
    const peerDir = join(root, 'releases', 'skill-c', '1', '.staging-peer');
    await mkdir(peerDir, { recursive: true });
    await writeFile(join(peerDir, 'KEEP'), 'peer-staging');
    await rm(materialized.releaseRoot, { recursive: true, force: true });
    arm = true;

    const pointer = { version: 1 };
    const target = {
      skillId: 'skill-c',
      version: 1,
      manifestHash: materialized.manifestHash,
      skillMd,
      entries: [] as SkillManifestEntry[],
    };
    const deps = {
      listCurrentPublished: async () => [{ ...target, version: pointer.version }],
      releaseStore: release,
      markUnavailable: async () => {
        throw new Error('race rebuild must stay available');
      },
    };
    const first = reconcileSkills({ dryRun: false }, deps);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = reconcileSkills({ dryRun: false }, deps);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await readFile(join(peerDir, 'KEEP'), 'utf8'), 'peer-staging');
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(pointer.version, 1);
    assert.equal(a.rebuilt.length + b.rebuilt.length, 1);
    assert.equal(await readFile(join(materialized.releaseRoot, 'SKILL.md'), 'utf8'), skillMd);
    assert.equal(await readFile(join(peerDir, 'KEEP'), 'utf8'), 'peer-staging');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GC keeps active pins, current releases, and fresh blobs; deletes only grace-elapsed unreferenced content on apply', async () => {
  const now = Date.UTC(2026, 9, 19);
  const hash = (label: string) => sha256Hex(label);
  const fresh = hash('fresh-blob');
  const stale = hash('stale-blob');
  const referenced = hash('referenced-blob');
  const inventory: SkillGcInventory = {
    nowMs: now,
    blobs: [
      { hash: fresh, mtimeMs: now - DAY, referenced: false },
      { hash: stale, mtimeMs: now - 8 * DAY, referenced: false },
      { hash: referenced, mtimeMs: now - 30 * DAY, referenced: true },
    ],
    releases: [
      { id: 'cur', mtimeMs: now - 30 * DAY, currentPublished: true, activePin: false },
      { id: 'pinned', mtimeMs: now - 30 * DAY, currentPublished: false, activePin: true },
      { id: 'old-orphan', mtimeMs: now - 8 * DAY, currentPublished: false, activePin: false },
      { id: 'young-orphan', mtimeMs: now - DAY, currentPublished: false, activePin: false },
    ],
    staging: [
      { id: 'staging-young', mtimeMs: now - DAY },
      { id: 'staging-old', mtimeMs: now - 8 * DAY },
    ],
    importSessions: [
      { id: 'import-fresh-expired', kind: 'import', expiresAtMs: now - DAY, path: '/tmp/i1' },
      { id: 'import-old', kind: 'import', expiresAtMs: now - 8 * DAY, path: '/tmp/i2' },
      { id: 'sync-old', kind: 'sync', expiresAtMs: now - 8 * DAY, path: '/tmp/s1' },
    ],
    runEvents: [
      { id: 'exec-old', event: 'execute', createdAtMs: now - 91 * DAY },
      { id: 'load-recent', event: 'load', createdAtMs: now - 10 * DAY },
      { id: 'publish-old', event: 'publish', createdAtMs: now - 200 * DAY },
    ],
    runPins: [
      { id: 'active', expiresAtMs: now + DAY, renewed: true },
      { id: 'just-ended', expiresAtMs: now - DAY },
      { id: 'ended-long-ago', expiresAtMs: now - 8 * DAY },
    ],
  };

  const plan = planSkillGarbage(inventory);
  const ids = (kind: string) => plan.items.filter((item) => item.kind === kind && item.eligible).map((item) => item.id);
  assert.deepEqual(ids('blob'), [stale]);
  assert.deepEqual(ids('release'), ['old-orphan']);
  assert.deepEqual(ids('staging'), ['staging-old']);
  assert.deepEqual(ids('import-temp').sort(), ['import-old', 'sync-old']);
  assert.deepEqual(ids('run-event'), ['exec-old']);
  assert.deepEqual(ids('run-pin'), ['ended-long-ago']);

  const deleted: string[] = [];
  const dry = await runSkillGc({ apply: false, inventory, deleteId: async (id) => { deleted.push(id); } });
  assert.equal(dry.applied, false);
  assert.equal(deleted.length, 0);
  assert.ok(dry.eligibleIds.includes(stale));
  assert.ok(dry.eligibleIds.includes('ended-long-ago'));

  const applied = await runSkillGc({ apply: true, inventory, deleteId: async (id) => { deleted.push(id); } });
  assert.equal(applied.applied, true);
  assert.deepEqual(deleted.sort(), [
    'ended-long-ago',
    'exec-old',
    'import-old',
    'old-orphan',
    'staging-old',
    'sync-old',
    stale,
  ].sort());
});

test('filesystem GC apply removes only grace-elapsed unreferenced blobs and old staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-gc-fs-'));
  const importRoot = await mkdtemp(join(tmpdir(), 'skills-gc-import-'));
  try {
    const now = Date.now();
    const blobs = createBlobStore({ root });
    const fresh = await blobs.put(Readable.from([Buffer.from('fresh')]), 64);
    const stale = await blobs.put(Readable.from([Buffer.from('stale-unreferenced')]), 64);
    const kept = await blobs.put(Readable.from([Buffer.from('referenced')]), 64);
    const oldDate = new Date(now - 8 * SKILL_GC_GRACE_MS / 7);
    await utimes(join(root, 'blobs', stale.hash), oldDate, oldDate);

    const release = createReleaseStore({ root, blobStore: blobs });
    const skillMd = '---\nname: demo\ndescription: d\n---\n\n# Keep\n';
    const materialized = await release.materialize('skill-d', 1, {
      skillId: 'skill-d',
      version: 1,
      skillMd,
      entries: [],
    });
    const stagingOld = join(root, 'releases', 'skill-d', '1', '.staging-old');
    await mkdir(stagingOld, { recursive: true });
    await writeFile(join(stagingOld, 'SKILL.md'), 'orphan');
    await utimes(stagingOld, oldDate, oldDate);
    const stagingYoung = join(root, 'releases', 'skill-d', '1', '.staging-young');
    await mkdir(stagingYoung, { recursive: true });
    await writeFile(join(stagingYoung, 'SKILL.md'), 'busy');

    const expiredImport = join(importRoot, 'import-old');
    await mkdir(expiredImport, { recursive: true });
    await writeFile(join(expiredImport, 'payload'), 'zip');

    const inventory = await collectSkillStorageInventory({
      storageRoot: root,
      nowMs: now,
      referencedBlobHashes: new Set([kept.hash]),
      currentReleaseIds: new Set([`skill-d/1/${materialized.manifestHash}`]),
      activePinReleaseIds: new Set(),
      importSessions: [{
        id: 'import-old',
        kind: 'import',
        expiresAtMs: now - 8 * DAY,
        path: expiredImport,
      }],
      runEvents: [],
      runPins: [],
    });
    const removed: string[] = [];
    await runSkillGc({
      apply: true,
      inventory,
      deleteId: async (id) => {
        removed.push(id);
        if (id === stale.hash) await rm(join(root, 'blobs', id), { force: true });
        if (id === 'staging-old' || id.endsWith('.staging-old')) await rm(stagingOld, { recursive: true, force: true });
        if (id === 'import-old') await rm(expiredImport, { recursive: true, force: true });
      },
    });

    assert.equal(await readFile(join(root, 'blobs', fresh.hash), 'utf8'), 'fresh');
    assert.equal(await readFile(join(root, 'blobs', kept.hash), 'utf8'), 'referenced');
    await assert.rejects(() => stat(join(root, 'blobs', stale.hash)));
    assert.equal(await readFile(join(materialized.releaseRoot, 'SKILL.md'), 'utf8'), skillMd);
    await assert.rejects(() => stat(stagingOld));
    assert.equal(await readFile(join(stagingYoung, 'SKILL.md'), 'utf8'), 'busy');
    await assert.rejects(() => stat(expiredImport));
    assert.ok(removed.includes(stale.hash));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(importRoot, { recursive: true, force: true });
  }
});

test('orphan skill containers are removed on apply and ordinary sandboxes are untouched', async () => {
  const now = Date.now();
  const removed: string[] = [];
  const engine = {
    async findLabeled(label: string, value: string) {
      assert.equal(label, 'nero.skill-run');
      assert.equal(value, '1');
      return [
        {
          Id: 'skill-old',
          Created: new Date(now - 20 * 60 * 1000).toISOString(),
          Config: { Labels: { 'nero.skill-run': '1' } },
        },
        {
          Id: 'sandbox-user',
          Created: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
          Config: { Labels: { 'nero.skill-run': '1', 'nero.sandbox': '1' } },
        },
        {
          Id: 'skill-young',
          Created: new Date(now - 60 * 1000).toISOString(),
          Config: { Labels: { 'nero.skill-run': '1' } },
        },
      ];
    },
    async remove(id: string) {
      removed.push(id);
    },
  };

  const dry = await reconcileOrphanSkillContainers(engine, { apply: false, now });
  assert.deepEqual(dry.removed, []);
  assert.ok(dry.wouldRemove.includes('skill-old'));
  assert.ok(dry.skipped.includes('sandbox-user'));
  assert.equal(removed.length, 0);

  const applied = await reconcileOrphanSkillContainers(engine, { apply: true, now });
  assert.deepEqual(applied.removed, ['skill-old']);
  assert.ok(applied.skipped.includes('sandbox-user'));
  assert.ok(applied.skipped.includes('skill-young'));
  assert.deepEqual(removed, ['skill-old']);
});
