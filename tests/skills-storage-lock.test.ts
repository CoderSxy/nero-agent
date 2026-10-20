import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { withSkillStorageReadLock, withSkillStorageWriteLock } from '../src/mastra/skills/storage-lock.ts';

test('storage leases are reentrant, release on failure, and never upgrade a read lease', async () => {
  const queries: string[] = [];
  let releases = 0;
  const pool = { async connect() { return {
    async query(sql: string) { queries.push(sql); return { rows: [] }; },
    release() { releases += 1; },
  }; } } as unknown as Pool;
  await assert.rejects(() => withSkillStorageReadLock(pool, async () => {
    await withSkillStorageReadLock(pool, async () => {});
    await assert.rejects(() => withSkillStorageWriteLock(pool, async () => {}), /Cannot upgrade/);
    throw new Error('writer failed');
  }), /writer failed/);
  assert.equal(queries.length, 2);
  assert.match(queries[0]!, /pg_advisory_lock_shared/);
  assert.match(queries[1]!, /pg_advisory_unlock_shared/);
  assert.equal(releases, 1);
  await withSkillStorageWriteLock(pool, () => withSkillStorageReadLock(pool, async () => {}));
  assert.equal(queries.length, 4);
});

test('failed unlock destroys the coordination connection instead of returning a locked session', async () => {
  let releaseError: unknown;
  const pool = { async connect() { return {
    async query(sql: string) { if (sql.includes('unlock')) throw new Error('socket closed'); return { rows: [] }; },
    release(error: unknown) { releaseError = error; },
  }; } } as unknown as Pool;
  await withSkillStorageReadLock(pool, async () => {});
  assert.match(String(releaseError), /socket closed/);
});
