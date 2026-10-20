import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { applyProductionGc, type SkillGcInventory } from '../src/mastra/skills/reconcile.ts';

for (const protection of ['rollback', 'new-pin', 'new-blob-reference'] as const) {
  test(`GC rechecks ${protection} under its storage lease before deleting old candidates`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-gc-race-'));
    const before = process.env.SKILLS_STORAGE_ROOT;
    process.env.SKILLS_STORAGE_ROOT = root;
    const hash = 'a'.repeat(64);
    const skillId = '11111111-1111-4111-8111-111111111111';
    const releaseId = `${skillId}/1/${hash}`;
    const path = protection === 'new-blob-reference'
      ? join(root, 'blobs', hash)
      : join(root, 'releases', releaseId, 'SKILL.md');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'keep');
    const now = Date.now();
    const inventory: SkillGcInventory = {
      nowMs: now,
      blobs: protection === 'new-blob-reference' ? [{ hash, mtimeMs: 0, referenced: false }] : [],
      releases: protection !== 'new-blob-reference'
        ? [{ id: releaseId, mtimeMs: 0, currentPublished: false, activePin: false }] : [],
      staging: [], importSessions: [], runEvents: [], runPins: [],
    };
    const sql: string[] = [];
    let freshReads = 0;
    const client = { async query(query: string) { sql.push(query); return { rows: [] }; }, release() {} };
    const pool = { async connect() { return client; } } as unknown as Pool;
    try {
      await applyProductionGc({
        apply: true,
        inventory,
        pool,
        loadInventory: async () => {
          freshReads += 1;
          assert.ok(sql.some(query => query.includes('pg_advisory_lock(')));
          return {
            ...inventory,
            blobs: inventory.blobs.map(blob => ({ ...blob, referenced: true })),
            releases: inventory.releases.map(release => ({ ...release,
              currentPublished: protection === 'rollback', activePin: protection === 'new-pin' })),
          };
        },
      } as Parameters<typeof applyProductionGc>[0]);
      assert.equal(await readFile(path, 'utf8'), 'keep');
      assert.equal(freshReads, 1);
      assert.ok(sql.at(-1)?.includes('pg_advisory_unlock('));
    } finally {
      if (before === undefined) delete process.env.SKILLS_STORAGE_ROOT;
      else process.env.SKILLS_STORAGE_ROOT = before;
      await rm(root, { recursive: true, force: true });
    }
  });
}

function safeTestDatabase(): boolean {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '5433' && url.pathname === '/nero_agent';
  } catch { return false; }
}

test('real PostgreSQL: GC waits for a separate publisher connection before obtaining its fresh snapshot', { skip: !safeTestDatabase() }, async () => {
  const { Pool: PgPool } = await import('pg');
  const { withSkillStorageReadLock } = await import('../src/mastra/skills/storage-lock.ts');
  const writer = new PgPool({ connectionString: process.env.DATABASE_URL });
  const collector = new PgPool({ connectionString: process.env.DATABASE_URL });
  const root = await mkdtemp(join(tmpdir(), 'skill-gc-pg-race-'));
  const before = process.env.SKILLS_STORAGE_ROOT;
  process.env.SKILLS_STORAGE_ROOT = root;
  let releaseWriter!: () => void;
  let writerReady!: () => void;
  const gate = new Promise<void>(resolve => { releaseWriter = resolve; });
  const ready = new Promise<void>(resolve => { writerReady = resolve; });
  const releaseId = `11111111-1111-4111-8111-111111111111/1/${'b'.repeat(64)}`;
  const path = join(root, 'releases', releaseId, 'SKILL.md');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'current');
  let currentPublished = false;
  let scanned = false;
  try {
    const publish = withSkillStorageReadLock(writer, async () => {
      writerReady();
      await gate;
      currentPublished = true;
    });
    await ready;
    const gc = applyProductionGc({ apply: true, pool: collector, loadInventory: async () => {
      scanned = true;
      return { nowMs: Date.now(), blobs: [], staging: [], importSessions: [], runEvents: [], runPins: [],
        releases: [{ id: releaseId, mtimeMs: 0, currentPublished, activePin: false }] };
    } });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(scanned, false, 'exclusive GC lease must wait for the publishing instance');
    releaseWriter();
    await publish;
    await gc;
    assert.equal(scanned, true);
    assert.equal(await readFile(path, 'utf8'), 'current');
  } finally {
    releaseWriter();
    if (before === undefined) delete process.env.SKILLS_STORAGE_ROOT; else process.env.SKILLS_STORAGE_ROOT = before;
    await rm(root, { recursive: true, force: true });
    await writer.end(); await collector.end();
  }
});


test('execution recovery holds the storage lease across pin read and renewal', async () => {
  const { RequestContext } = await import('@mastra/core/request-context');
  const { resolveSkillExecution } = await import('../src/mastra/skills/execution-context.ts');
  const { createSkillRepository } = await import('../src/mastra/skills/repository.ts');
  const queries: string[] = [];
  let held = false;
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes('pg_advisory_lock_shared')) held = true;
      if (sql.includes('pg_advisory_unlock_shared')) held = false;
      return { rows: [] };
    },
    release() {},
  };
  const repository = createSkillRepository({ async connect() { return client; } } as unknown as Pool);
  const skillId = '11111111-1111-4111-8111-111111111111';
  repository.listRunPins = async () => {
    assert.equal(held, true, 'pin lookup must be protected from GC');
    return [{ skillId, name: 'example', version: 1, manifestHash: 'a'.repeat(64), instructionsLoaded: true }] as Awaited<ReturnType<typeof repository.listRunPins>>;
  };
  repository.touchRunPins = async input => {
    assert.deepEqual(input.skillIds, [skillId], 'renew only pins observed under this lease');
    assert.equal(held, true, 'pin renewal must share the lookup lease');
  };
  const requestContext = new RequestContext();
  requestContext.set('mastra__user', { id: '22222222-2222-4222-8222-222222222222', roles: ['user'] });
  const context = await resolveSkillExecution({ requestContext, repository, serverExecutionId: 'recovery-run', threadId: 'recovery-thread' });
  assert.equal(context.pins.get(skillId)?.version, 1);
  assert.ok(context.loadedSkillIds?.has(skillId));
  assert.equal(held, false);
  assert.equal(queries.filter(sql => sql.includes('pg_advisory_lock_shared')).length, 1);
  assert.ok(queries.at(-1)?.includes('pg_advisory_unlock_shared'));
  repository.touchRunPins = async () => { throw new Error('renewal unavailable'); };
  await assert.rejects(resolveSkillExecution({ requestContext, repository, serverExecutionId: 'recovery-run', threadId: 'recovery-thread' }), /renewal unavailable/);
  assert.equal(held, false, 'renewal failures must release the lease');
});


test('pin renewal scopes the UPDATE to the recovered snapshot', async () => {
  const { createSkillRepository } = await import('../src/mastra/skills/repository.ts');
  const skillIds = ['11111111-1111-4111-8111-111111111111'];
  let recordedSql = '';
  let recordedValues: unknown[] = [];
  const repository = createSkillRepository({
    async query(sql: string, values: unknown[]) { recordedSql = sql; recordedValues = values; return { rows: [] }; },
  } as unknown as Pool);
  await repository.touchRunPins({ serverExecutionId: 'run', userId: 'user', threadId: 'thread', skillIds });
  assert.match(recordedSql, /skill_id = ANY\(\$5::uuid\[\]\)/);
  assert.deepEqual(recordedValues[4], skillIds);
});
