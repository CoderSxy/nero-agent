import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getPool } from '../src/mastra/auth/db.ts';
import { SandboxRegistry } from '../src/mastra/sandbox/registry.ts';
import { sandboxIdFor } from '../src/mastra/sandbox/types.ts';

function safeLocalDatabase(): boolean {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return ['127.0.0.1', 'localhost'].includes(url.hostname)
      && url.port === '5433' && url.pathname === '/nero_agent';
  } catch { return false; }
}

test('PostgreSQL sandbox registry persists user scope on create, update and clear', {
  skip: !safeLocalDatabase() && 'Requires local PostgreSQL on 127.0.0.1:5433/nero_agent',
}, async () => {
  const pool = getPool();
  const userId = randomUUID();
  const registry = new SandboxRegistry();
  const owner = { userId, sandboxId: sandboxIdFor(userId) };
  try {
    await pool.query(`INSERT INTO app_users (id,email,display_name,password_hash)
      VALUES ($1,$2,$3,$4)`, [userId, `sandbox-registry-${userId}@example.test`, 'Sandbox registry test', 'not-a-login-hash']);
    await registry.upsert({ ...owner, containerId: 'fixture-' + userId,
      status: 'running', workspaceRoot: '/workspace/test', lastActiveAt: Date.now() });
    const row = (await pool.query('SELECT scope,scope_id,status FROM app_sandbox_instances WHERE user_id=$1', [userId])).rows[0];
    assert.equal(row.scope, 'user');
    assert.equal(row.scope_id, userId);
    assert.equal(row.status, 'running');
    await registry.upsert({ ...owner, containerId: 'replacement-' + userId,
      status: 'stopped', workspaceRoot: '/workspace/test', lastActiveAt: Date.now() });
    assert.equal((await registry.getByUser(userId))?.containerId, 'replacement-' + userId);
    await registry.clearContainer(owner, 'missing');
    assert.equal((await registry.getByUser(userId))?.containerId, undefined);
    const cleared = (await pool.query('SELECT scope,scope_id,status FROM app_sandbox_instances WHERE user_id=$1', [userId])).rows[0];
    assert.deepEqual(cleared, { scope: 'user', scope_id: userId, status: 'missing' });
  } finally {
    await pool.query('DELETE FROM app_users WHERE id=$1', [userId]);
    await pool.end();
  }
});
