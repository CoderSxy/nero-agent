import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeSandboxProvider } from '../src/mastra/sandbox/fake-provider';
import { SandboxCleaner, startSandboxCleanup } from '../src/mastra/sandbox/cleaner';
import { SandboxRegistry } from '../src/mastra/sandbox/registry';
import { sandboxIdFor } from '../src/mastra/sandbox/types';

const USER = 'dddddddd-4444-4444-8444-444444444444';

test('cleaner stops idle sandboxes, removes long-stopped ones, and never deletes workspace files', async () => {
  process.env.SANDBOX_IDLE_STOP_MS = '1000';
  process.env.SANDBOX_REMOVE_AFTER_MS = '5000';
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'clean-ws-'));
  const keep = join(process.env.WORKSPACE_ROOT, 'users', USER, 'workspace', 'keep.txt');
  await mkdir(join(process.env.WORKSPACE_ROOT, 'users', USER, 'workspace'), { recursive: true });
  await writeFile(keep, 'keep');
  const registry = new SandboxRegistry();
  const provider = new FakeSandboxProvider();
  const owner = { userId: USER, sandboxId: sandboxIdFor(USER) };
  await provider.ensureRunning(owner, join(process.env.WORKSPACE_ROOT, 'users', USER, 'workspace'));
  await registry.upsert({
    userId: USER,
    sandboxId: owner.sandboxId,
    containerId: 'c1',
    status: 'running',
    lastActiveAt: 0,
  });
  const busy = new Set<string>();
  const cleaner = new SandboxCleaner(provider, registry, async () => [owner], userId => busy.has(userId));
  busy.add(USER);
  const skipped = await cleaner.runOnce(10_000);
  assert.deepEqual(skipped.skipped, [USER]);
  busy.delete(USER);
  const stopped = await cleaner.runOnce(10_000);
  assert.deepEqual(stopped.stopped, [USER]);
  await registry.upsert({
    ...(await registry.getByUser(USER))!,
    status: 'stopped',
    lastActiveAt: 0,
  });
  const removed = await cleaner.runOnce(10_000);
  assert.deepEqual(removed.removed, [USER]);
  assert.equal(await readFile(keep, 'utf8'), 'keep');
  await provider.ensureRunning(owner, join(process.env.WORKSPACE_ROOT, 'users', USER, 'workspace'));
  assert.equal((await provider.inspect(owner)).status, 'running');
});

test('cleanup scheduler invokes the sweep and can be stopped', async () => {
  let tick: (() => void) | undefined;
  let stopped = false;
  const calls: number[] = [];
  const cleaner = { runOnce: async (now: number) => { calls.push(now); return { stopped: [], removed: [], skipped: [] }; } };
  const stop = startSandboxCleanup(cleaner, {
    schedule: callback => { tick = callback; return { unref() {}, close() { stopped = true; } }; },
    now: () => 123,
  });
  tick?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [123]);
  stop();
  assert.equal(stopped, true);
});
