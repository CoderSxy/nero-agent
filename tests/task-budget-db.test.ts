import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getPool } from '../src/mastra/auth/db';
import { reserveRunOperation } from '../src/mastra/agents/task-quality/run-control-repository';

function safeDatabase(): boolean {
  try {
    const parsed = new URL(process.env.DATABASE_URL ?? '');
    return (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
      && parsed.port === '5433'
      && parsed.pathname.replace(/^\//, '') === 'nero_agent';
  } catch {
    return false;
  }
}

test('two database connections cannot both take the last model call', { skip: safeDatabase() ? false : 'BLOCKED_ENV: budget DB test needs localhost:5433/nero_agent' }, async () => {
  const pool = getPool();
  const userA = randomUUID();
  const userB = randomUUID();
  const runId = `budget-${randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query(`INSERT INTO app_users (id, email, display_name, password_hash) VALUES ($1, $2, 'Budget', 'x'), ($3, $4, 'Other', 'x')`,
      [userA, `budget-${userA}@example.test`, userB, `budget-${userB}@example.test`]);
    const auth = { userId: userA, threadId: 'thread-budget' };
    for (let index = 0; index < 7; index += 1) {
      const decision = await reserveRunOperation(auth, { runId, operationId: `m${index}`, kind: 'main-model', profile: 'simple-chart', mode: 'enforce' });
      assert.equal(decision.allowed, true);
    }
    const [left, right] = await Promise.all([
      reserveRunOperation(auth, { runId, operationId: 'left', kind: 'main-model', profile: 'simple-chart', mode: 'enforce' }),
      reserveRunOperation(auth, { runId, operationId: 'right', kind: 'main-model', profile: 'simple-chart', mode: 'enforce' }),
    ]);
    assert.equal([left, right].filter(item => item.allowed).length, 1);
    const winner = left.allowed ? 'left' : 'right';
    const replay = await reserveRunOperation(auth, { runId, operationId: winner, kind: 'main-model', profile: 'simple-chart', mode: 'enforce' });
    assert.equal(replay.duplicate, true);
    const foreign = await reserveRunOperation({ userId: userB, threadId: 'thread-budget' }, { runId, operationId: 'foreign', kind: 'main-model', profile: 'simple-chart', mode: 'enforce' });
    assert.equal(foreign.reason, 'owner');
    const resumed = await reserveRunOperation(auth, { runId, operationId: 'tool-1', kind: 'tool', profile: 'simple-chart', mode: 'enforce' });
    assert.equal(resumed.allowed, true);
    assert.equal(resumed.remaining.mainRequests, 0);
  } finally {
    await client.query(`DELETE FROM app_agent_run_controls WHERE run_id = $1`, [runId]);
    await client.query(`DELETE FROM app_users WHERE id IN ($1, $2)`, [userA, userB]);
    client.release();
  }
});
