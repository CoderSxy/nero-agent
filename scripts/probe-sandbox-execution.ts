/** Operator probe: real thread ownership, registry, Docker provisioning and execute_command domain path. */
import assert from 'node:assert/strict';
import { getPool } from '../src/mastra/auth/db.ts';
import { getActiveUserById } from '../src/mastra/auth/service.ts';
import { createDockerodeEngine } from '../src/mastra/sandbox/docker/client.ts';
import { DockerSandboxProvider } from '../src/mastra/sandbox/docker/provider.ts';
import { SandboxRegistry } from '../src/mastra/sandbox/registry.ts';
import { SandboxManager } from '../src/mastra/sandbox/manager.ts';
import { sandboxIdFor } from '../src/mastra/sandbox/types.ts';

const [userId, threadId] = process.argv.slice(2);
if (!userId || !threadId) throw new Error('Usage: probe-sandbox-execution.mjs <user-id> <existing-thread-id>');
if (process.env.SANDBOX_NETWORK_MODE && process.env.SANDBOX_NETWORK_MODE !== 'none') throw new Error('This probe is offline only');
const pool = getPool();
const registry = new SandboxRegistry();
const provider = new DockerSandboxProvider(await createDockerodeEngine(), registry);
const owner = { userId, sandboxId: sandboxIdFor(userId) };
let started = false;
try {
  const user = await getActiveUserById(userId);
  assert.ok(user, 'User must be active');
  const lookup = { async getThreadById({ threadId: id }: { threadId: string }) {
    const result = await pool.query(`SELECT id, to_jsonb(t)->>'resourceId' AS resource,
      to_jsonb(t)->>'resource_id' AS legacy_resource FROM mastra_threads t WHERE id=$1`, [id]);
    const row = result.rows[0];
    return row ? { id: row.id, resourceId: row.resource ?? row.legacy_resource } : null;
  } };
  const thread = await lookup.getThreadById({ threadId });
  assert.equal(thread?.resourceId, userId, 'Actual database thread must belong to this user');
  const manager = new SandboxManager(provider, lookup);
  const result = await manager.execute({ auth: { userId: user.id, roles: user.roles }, threadId,
    command: 'python3', args: ['-c', 'import json,pptx; print(json.dumps({"execution":"ok","python_pptx":pptx.__version__}))'] });
  started = true;
  assert.equal(result.exitCode, 0, result.stderr);
  const row = (await pool.query('SELECT scope,scope_id,status FROM app_sandbox_instances WHERE user_id=$1', [userId])).rows[0];
  assert.equal(row.scope_id, userId);
  assert.equal(row.scope, 'user');
  assert.equal(row.status, 'running');
  console.log('SANDBOX_EXECUTION_OK', result.stdout.trim());
} finally {
  if (started) await provider.stop(owner);
  await pool.end();
}
