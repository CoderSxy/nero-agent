import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../src/mastra/auth/auth-context';
import {
  withWorkspaceMutation,
  createInMemoryMutationAdapter,
  createPgMutationAdapter,
  isWorkspaceMutationToken,
  workspaceMutationAdapter,
  type WorkspaceMutationToken,
} from '../src/mastra/files/artifacts/mutation-coordinator';

function auth(userId = randomUUID()): AuthContext {
  return { userId, roles: ['user'] };
}

test('same user mutations do not overlap; different users may run concurrently', async () => {
  const adapter = createInMemoryMutationAdapter();
  const a = auth();
  const b = auth();
  const events: string[] = [];

  const first = withWorkspaceMutation(a, async () => {
    events.push('a-enter');
    await new Promise((r) => setTimeout(r, 40));
    events.push('a-exit');
    return 1;
  }, { adapter });

  const secondStarted = new Promise<void>((resolve) => {
    void withWorkspaceMutation(a, async () => {
      resolve();
      events.push('a2-enter');
      events.push('a2-exit');
      return 2;
    }, { adapter });
  });

  const other = withWorkspaceMutation(b, async () => {
    events.push('b-enter');
    await new Promise((r) => setTimeout(r, 10));
    events.push('b-exit');
    return 3;
  }, { adapter });

  await Promise.all([first, other]);
  await secondStarted;
  // a2 must wait until a exits
  const aEnter = events.indexOf('a-enter');
  const aExit = events.indexOf('a-exit');
  const a2Enter = events.indexOf('a2-enter');
  assert.ok(aEnter < aExit);
  assert.ok(aExit <= a2Enter);
  // b may overlap a
  assert.ok(events.includes('b-enter'));
});

test('exception and cancel release the lock for the next waiter', async () => {
  const adapter = createInMemoryMutationAdapter();
  const user = auth();
  await assert.rejects(
    () => withWorkspaceMutation(user, async () => {
      throw new Error('boom');
    }, { adapter }),
    /boom/,
  );
  const value = await withWorkspaceMutation(user, async () => 7, { adapter });
  assert.equal(value, 7);

  const controller = new AbortController();
  const blocked = withWorkspaceMutation(user, async () => {
    await new Promise((r) => setTimeout(r, 80));
    return 'held';
  }, { adapter });
  const waiting = withWorkspaceMutation(user, async () => 'next', {
    adapter,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(() => waiting, /abort|AbortError|cancelled/i);
  assert.equal(await blocked, 'held');
  assert.equal(await withWorkspaceMutation(user, async () => 'ok', { adapter }), 'ok');
});

test('held token reenters without self-deadlock; forged or cross-user tokens are rejected', async () => {
  const adapter = createInMemoryMutationAdapter();
  const user = auth();
  const other = auth();

  const nested = await withWorkspaceMutation(user, async (token) => {
    assert.equal(isWorkspaceMutationToken(token), true);
    return withWorkspaceMutation(user, async (inner) => {
      assert.equal(inner, token);
      return 'nested';
    }, { adapter, token });
  }, { adapter });
  assert.equal(nested, 'nested');

  const forged = { userId: user.userId } as unknown as WorkspaceMutationToken;
  await assert.rejects(
    () => withWorkspaceMutation(user, async () => 'nope', { adapter, token: forged }),
    /token|invalid|forged/i,
  );

  await withWorkspaceMutation(user, async (token) => {
    await assert.rejects(
      () => withWorkspaceMutation(other, async () => 'x', { adapter, token }),
      /token|owner|user/i,
    );
  }, { adapter });
});

test('original work return value and exception pass through unchanged', async () => {
  const adapter = createInMemoryMutationAdapter();
  const user = auth();
  assert.equal(await withWorkspaceMutation(user, async () => 42, { adapter }), 42);
  await assert.rejects(
    () => withWorkspaceMutation(user, async () => {
      throw new TypeError('typed');
    }, { adapter }),
    (error: unknown) => error instanceof TypeError && (error as Error).message === 'typed',
  );
});

const hasDb = Boolean(process.env.DATABASE_URL);

test('PG adapter serializes two connections for the same user', {
  skip: !hasDb,
}, async () => {
  const url = process.env.DATABASE_URL!;
  if (!/localhost|127\.0\.0\.1/i.test(url)) {
    assert.fail('refusing non-loopback DATABASE_URL for mutation lock test');
  }
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url, max: 4 });
  try {
    const adapter = createPgMutationAdapter(pool);
    const user = auth();
    let active = 0;
    let maxActive = 0;
    const run = async (label: string, delayMs: number) => withWorkspaceMutation(user, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, delayMs));
      active -= 1;
      return label;
    }, { adapter });
    const results = await Promise.all([run('a', 60), run('b', 10)]);
    assert.deepEqual(results.sort(), ['a', 'b']);
    assert.equal(maxActive, 1, 'two PG connections must not hold the same user lock together');
  } finally {
    await pool.end();
  }
});

test('PG lock waiters leave a connection available for the lock holder', { skip: !hasDb }, async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url.toString(), max: 2 });
  const adapter = createPgMutationAdapter(pool);
  const userId = randomUUID();
  const release = await adapter.acquire(userId);
  const controller = new AbortController();
  const waiter = adapter.acquire(userId, controller.signal).then(async done => { await done(); }, () => {});
  let available = false;
  let query: Promise<unknown> | undefined;
  try {
    await new Promise(resolve => setTimeout(resolve, 80));
    query = pool.query('SELECT 1');
    available = await Promise.race([query.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 200))]);
  } finally {
    controller.abort();
    await waiter;
    await release();
    await query;
    await pool.end();
  }
  assert.equal(available, true, 'a waiter must not monopolize the connection required by the owner');
});

test('PG acquisition can be cancelled while waiting for a pooled connection', { skip: !hasDb }, async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const held = await pool.connect();
  const controller = new AbortController();
  let cancelled = false;
  const attempt = createPgMutationAdapter(pool).acquire(randomUUID(), controller.signal)
    .then(async release => { await release(); }, () => { cancelled = true; });
  try {
    controller.abort();
    await Promise.race([attempt, new Promise(resolve => setTimeout(resolve, 100))]);
    assert.equal(cancelled, true, 'cancel must not wait for a connection to become free');
  } finally {
    held.release();
    await attempt;
    await pool.end();
  }
});


test('two long mutations do not block an unrelated user upload', { skip: !hasDb }, async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  const adapter = workspaceMutationAdapter();
  const first = await adapter.acquire(randomUUID());
  const second = await adapter.acquire(randomUUID());
  const controller = new AbortController();
  let releaseThird: (() => Promise<void>) | undefined;
  const third = adapter.acquire(randomUUID(), controller.signal)
    .then(release => { releaseThird = release; return true; }, () => false);
  let entered = false;
  try {
    entered = await Promise.race([third, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250))]);
  } finally {
    controller.abort();
    await first(); await second();
    await third;
    await releaseThird?.();
  }
  assert.equal(entered, true, 'independent users need lock capacity beyond the two sandbox command slots');
});
