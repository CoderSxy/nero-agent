import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import {
  inspectSkillStorage,
  recheckSkillStorage,
  resetSkillHealthRechecks,
  skillDoctorExitCode,
  SkillHealthInfrastructureError,
  type SkillHealthReport,
} from '../src/mastra/skills/health.ts';
import { createMemorySkillHealthRepository, createSkillHealthRepository } from '../src/mastra/skills/health-repository.ts';
import { reconcileSkills, type ReconcileTarget } from '../src/mastra/skills/reconcile.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';
import { parseDoctorArgs } from '../scripts/skills-doctor.ts';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'skill-health-'));
  const before = await readdir(root);
  const marker = join(root, 'marker.txt');
  await writeFile(marker, 'keep');
  const markerStat = await stat(marker);
  const blobs = createBlobStore({ root });
  const release = createReleaseStore({ root, blobStore: blobs });
  const skillMd = '---\nname: demo\ndescription: instructions\n---\n\n# Demo\n';
  const refBytes = Buffer.from('reference body\n', 'utf8');
  const refPut = await blobs.put(Readable.from([refBytes]), 1024);
  const entries = [{ path: 'references/note.md', blobHash: refPut.hash, size: refPut.size, isText: true }];
  const materialized = await release.materialize('skill-a', 1, { skillId: 'skill-a', version: 1, skillMd, entries });
  const target: ReconcileTarget = {
    skillId: 'skill-a',
    version: 1,
    manifestHash: materialized.manifestHash,
    skillMd,
    entries,
  };
  return { root, before, marker, markerStat, blobs, release, target, materialized, refPut };
}

test('complete release and blobs are healthy, including instruction-only skills', async () => {
  const fx = await fixture();
  try {
    const report = await inspectSkillStorage(fx.target, { releaseStore: fx.release, blobStore: fx.blobs });
    assert.equal(report.status, 'healthy');
    assert.equal(report.safeCode, null);
    const instructions = { ...fx.target, entries: [] };
    const only = await fx.release.materialize('skill-a', 2, {
      skillId: 'skill-a', version: 2, skillMd: fx.target.skillMd, entries: [],
    });
    const plain = await inspectSkillStorage({
      ...instructions,
      version: 2,
      manifestHash: only.manifestHash,
    }, { releaseStore: fx.release, blobStore: fx.blobs });
    assert.equal(plain.status, 'healthy');
    assert.equal(plain.resourceCount, 0);
    assert.equal(await readdir(join(fx.root, 'releases', 'skill-a', '2', only.manifestHash)).then(names => names.includes('scripts')), false);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('missing release tree is repairable only after blobs are read; a missing blob is unavailable', async () => {
  const fx = await fixture();
  try {
    await rm(fx.materialized.releaseRoot, { recursive: true, force: true });
    let reads = 0;
    const counting = {
      openVerified: async (hash: string) => {
        reads += 1;
        return fx.blobs.openVerified(hash);
      },
    };
    const repairable = await inspectSkillStorage(fx.target, { releaseStore: fx.release, blobStore: counting });
    assert.equal(repairable.status, 'repairable');
    assert.ok(reads >= 1);
    const changed = { ...fx.target, skillMd: `${fx.target.skillMd}\nchanged\n` };
    const mismatch = await inspectSkillStorage(changed, { releaseStore: fx.release, blobStore: fx.blobs });
    assert.equal(mismatch.status, 'unavailable');
    assert.equal(mismatch.safeCode, 'RELEASE_HASH_MISMATCH');

    await rm(join(fx.root, 'blobs', fx.refPut.hash), { force: true });
    const dry = await reconcileSkills({ dryRun: true }, {
      listCurrentPublished: async () => [fx.target],
      releaseStore: fx.release,
      markUnavailable: async () => undefined,
    });
    assert.equal(dry.wouldRebuild.length, 1);
    const unavailable = await inspectSkillStorage(fx.target, { releaseStore: fx.release, blobStore: fx.blobs });
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.safeCode, 'BLOB_MISSING');
    assert.equal(await stat(fx.materialized.releaseRoot).then(() => true, () => false), false);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('inspect does not create directories, repair files, or change mtime, and keeps read errors safe', async () => {
  const fx = await fixture();
  try {
    const corrupt = await inspectSkillStorage(fx.target, {
      releaseStore: fx.release,
      blobStore: {
        openVerified: async () => {
          const error = new Error('EACCES: /Users/secret/blobs/private') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        },
      },
    });
    assert.equal(corrupt.status, 'unavailable');
    assert.equal(corrupt.safeCode, 'BLOB_UNREADABLE');
    assert.equal(JSON.stringify(corrupt).includes('/Users/secret'), false);
    assert.equal(corrupt.resources[0]?.path, 'references/note.md');
    const after = await readdir(fx.root);
    assert.deepEqual(after.filter(name => name !== 'blobs' && name !== 'releases' && name !== 'marker.txt'), fx.before.filter(name => name !== 'marker.txt'));
    const next = await stat(fx.marker);
    assert.equal(next.mtimeMs, fx.markerStat.mtimeMs);
    assert.equal(createHash('sha256').update('keep').digest('hex'), createHash('sha256').update(await (await import('node:fs/promises')).readFile(fx.marker)).digest('hex'));
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('health cache is isolated by manifest hash and a failed check does not persist unavailable', async () => {
  resetSkillHealthRechecks();
  const repository = createMemorySkillHealthRepository();
  const calls: string[] = [];
  const fake = createSkillHealthRepository({
    query: async (sql, params) => {
      calls.push(sql);
      assert.deepEqual(params?.slice(0, 3), ['skill', 1, 'hash-a']);
      return { rows: [] };
    },
  });
  await fake.get('skill', 1, 'hash-a');
  assert.match(calls[0] ?? '', /manifest_hash/);
  const target: ReconcileTarget = {
    skillId: 'skill', version: 1, manifestHash: 'hash-a', skillMd: 'a', entries: [],
  };
  const healthy: SkillHealthReport = {
    skillId: 'skill', version: 1, manifestHash: 'hash-a', status: 'healthy', checkedAt: '2026-10-22T00:00:00.000Z',
    safeCode: null, resourceCount: 0, missingCount: 0, corruptCount: 0, resources: [],
  };
  await repository.upsert({ ...healthy, checkingStartedAt: null });
  await assert.rejects(() => recheckSkillStorage({
    target,
    repair: false,
    includeResources: false,
    repository,
    inspect: async () => { throw new SkillHealthInfrastructureError(); },
  }));
  const stored = await repository.get('skill', 1, 'hash-a');
  assert.notEqual(stored?.status, 'unavailable');
  await repository.upsert({ ...healthy, manifestHash: 'hash-b', checkingStartedAt: null });
  assert.equal((await repository.get('skill', 1, 'hash-a'))?.status, 'checking');
  assert.equal((await repository.get('skill', 1, 'hash-b'))?.status, 'healthy');
});

test('recheck merges the same target and returns checking after the wait budget', async () => {
  resetSkillHealthRechecks();
  const repository = createMemorySkillHealthRepository();
  const gate = deferred();
  let calls = 0;
  const target: ReconcileTarget = {
    skillId: 'skill', version: 1, manifestHash: 'hash-a', skillMd: 'a', entries: [],
  };
  const inspect = async (): Promise<SkillHealthReport> => {
    calls += 1;
    await gate.promise;
    return {
      skillId: 'skill', version: 1, manifestHash: 'hash-a', status: 'healthy', checkedAt: '2026-10-22T00:00:00.000Z',
      safeCode: null, resourceCount: 0, missingCount: 0, corruptCount: 0, resources: [],
    };
  };
  const first = recheckSkillStorage({ target, repair: false, includeResources: true, repository, inspect, timeoutMs: 1_000 });
  const second = recheckSkillStorage({ target, repair: false, includeResources: false, repository, inspect, timeoutMs: 1_000 });
  gate.resolve();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(left.status, 'done');
  assert.equal(right.report?.resources, undefined);
  resetSkillHealthRechecks();
  const slow = recheckSkillStorage({
    target,
    repair: false,
    includeResources: false,
    repository,
    timeoutMs: 10,
    inspect: () => new Promise(() => undefined),
  });
  const timed = await slow;
  assert.equal(timed.status, 'checking');
  resetSkillHealthRechecks();
});

test('doctor exit codes keep repairable successful and do not accept unknown arguments', () => {
  assert.equal(skillDoctorExitCode({ reports: [{ status: 'healthy' }, { status: 'repairable' }], infrastructureFailure: false }), 0);
  assert.equal(skillDoctorExitCode({ reports: [{ status: 'unavailable' }], infrastructureFailure: false }), 2);
  assert.equal(skillDoctorExitCode({ reports: [], infrastructureFailure: true }), 1);
  assert.equal(parseDoctorArgs(['--json']).json, true);
  assert.throws(() => parseDoctorArgs(['--repair']));
});
