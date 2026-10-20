import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';

/** Shared by every app instance connected to the same skills database. */
const STORAGE_LOCK_KEY = 'nero-agent-skills-storage-v1';
const leases = new AsyncLocalStorage<Map<Pool, 'shared' | 'exclusive'>>();
const coordinationPools = new WeakMap<Pool, Pool>();

function coordinator(pool: Pool): Pool {
  // Keep lock waiters out of the application's query pool: otherwise concurrent
  // readers can reserve every connection and deadlock their own metadata queries.
  if (!(pool instanceof Pool)) return pool; // Small injectable test adapters.
  let dedicated = coordinationPools.get(pool);
  if (!dedicated) {
    dedicated = new Pool({ ...pool.options, max: 2, allowExitOnIdle: true });
    coordinationPools.set(pool, dedicated);
  }
  return dedicated;
}

async function withStorageLock<T>(
  pool: Pool | undefined,
  mode: 'shared' | 'exclusive',
  operation: () => Promise<T>,
): Promise<T> {
  if (!pool) return operation();
  const held = leases.getStore();
  const current = held?.get(pool);
  if (current) {
    if (current === 'shared' && mode === 'exclusive') {
      throw new Error('Cannot upgrade an active skill storage read lease');
    }
    return operation();
  }
  const client = await coordinator(pool).connect();
  const suffix = mode === 'shared' ? '_shared' : '';
  let locked = false;
  let releaseError: Error | undefined;
  try {
    await client.query(`SELECT pg_advisory_lock${suffix}(hashtext($1))`, [STORAGE_LOCK_KEY]);
    locked = true;
    const next = new Map(held);
    next.set(pool, mode);
    return await leases.run(next, operation);
  } finally {
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock${suffix}(hashtext($1))`, [STORAGE_LOCK_KEY]);
      } catch (error) {
        // A session whose unlock failed must never be returned to the pool.
        releaseError = error instanceof Error ? error : new Error('Skill storage unlock failed');
      }
    }
    client.release(releaseError);
  }
}

/** Hold through blob write / resource verification AND metadata commit. Reentrant. */
export function withSkillStorageReadLock<T>(pool: Pool | undefined, operation: () => Promise<T>): Promise<T> {
  return withStorageLock(pool, 'shared', operation);
}

/** GC takes an exclusive lease, then obtains a fresh inventory before deletion. */
export function withSkillStorageWriteLock<T>(pool: Pool, operation: () => Promise<T>): Promise<T> {
  return withStorageLock(pool, 'exclusive', operation);
}
