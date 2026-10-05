import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import { listAgentToolIds } from '../src/mastra/agents/agent';
import { FakeSandboxProvider } from '../src/mastra/sandbox/fake-provider';
import { SandboxManager } from '../src/mastra/sandbox/manager';
import { disabledNativeWorkspaceTools, nativeCommandToolNames } from '../src/mastra/sandbox/native-tools';
import { ManagedWorkspaceSandbox } from '../src/mastra/sandbox/docker/workspace-adapter';
import { sandboxIdFor } from '../src/mastra/sandbox/types';
import { sandboxTools } from '../src/mastra/sandbox/tool';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const THREAD = 'thread-cmd';

function user(id: string, roles: AuthUser['roles'] = ['user']): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles };
}

function lookup() {
  return {
    getThreadById: async ({ threadId }: { threadId: string }) => {
      if (threadId === THREAD) return { id: threadId, resourceId: USER_A };
      return null;
    },
  };
}

test('tool userId and cwd arguments cannot change owner or thread cwd', async () => {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'sbx-cwd-'));
  process.env.SANDBOX_COMMANDS_ENABLED = 'true';
  process.env.SANDBOX_FILE_WRITE_ENABLED = 'true';
  process.env.WORKSPACE_HOST_QUOTA_VERIFIED = 'true';
  const provider = new FakeSandboxProvider();
  const manager = new SandboxManager(provider, lookup());
  const forged = {
    userId: USER_B,
    cwd: '/tmp/escape',
    threadId: THREAD,
    command: 'python3',
    args: ['analysis.py'],
  };
  await manager.execute({
    auth: authContextFromUser(user(USER_A)),
    threadId: forged.threadId,
    command: forged.command,
    args: forged.args,
  });
  assert.equal(provider.lastOwner?.userId, USER_A);
  assert.equal(provider.lastOwner?.sandboxId, sandboxIdFor(USER_A));
  assert.equal(provider.lastOptions?.cwd, `/workspace/threads/${THREAD}`);
  assert.notEqual(provider.lastOptions?.cwd, forged.cwd);
});

test('execute without threadId is rejected', async () => {
  process.env.SANDBOX_COMMANDS_ENABLED = 'true';
  const provider = new FakeSandboxProvider();
  const manager = new SandboxManager(provider, lookup());
  await assert.rejects(
    () =>
      manager.execute({
        auth: authContextFromUser(user(USER_A)),
        threadId: '',
        command: 'echo',
        args: ['hi'],
      }),
  );
  assert.equal(provider.executeCalls, 0);
});

test('ordinary chat does not call the sandbox provider', () => {
  const provider = new FakeSandboxProvider();
  new SandboxManager(provider, lookup());
  assert.equal(provider.ensureRunningCalls, 0);
  assert.equal(provider.executeCalls, 0);
});

test('native command tools are disabled and omitted from the agent tool list', () => {
  delete process.env.SANDBOX_COMMANDS_ENABLED;
  for (const name of nativeCommandToolNames()) {
    assert.equal(disabledNativeWorkspaceTools[name as keyof typeof disabledNativeWorkspaceTools].enabled, false);
  }
  const requestContext = new RequestContext();
  requestContext.set('mastra__user', user(USER_A));
  const ids = listAgentToolIds(requestContext);
  assert.ok(!ids.includes(WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND));
  assert.ok(!ids.includes('execute_command'));
  assert.deepEqual(sandboxTools(), {});
});

test('WorkspaceSandbox adapter routes executeCommand through the manager', async () => {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'sbx-adapter-'));
  process.env.SANDBOX_COMMANDS_ENABLED = 'true';
  process.env.SANDBOX_FILE_WRITE_ENABLED = 'true';
  process.env.WORKSPACE_HOST_QUOTA_VERIFIED = 'true';
  const provider = new FakeSandboxProvider();
  const manager = new SandboxManager(provider, lookup());
  const sandbox: ManagedWorkspaceSandbox = new ManagedWorkspaceSandbox(manager, {
    auth: authContextFromUser(user(USER_A)),
    threadId: THREAD,
  });
  const result = await sandbox.executeCommand('ls', ['-1'], { cwd: '/etc' });
  assert.equal(result.exitCode, 0);
  assert.equal(provider.lastOptions?.cwd, `/workspace/threads/${THREAD}`);
});

test('command execution rejects a missing host quota gate before creating a sandbox', async () => {
  process.env.SANDBOX_COMMANDS_ENABLED = 'true';
  delete process.env.WORKSPACE_HOST_QUOTA_VERIFIED;
  delete process.env.SANDBOX_FILE_WRITE_ENABLED;
  const provider = new FakeSandboxProvider();
  const manager = new SandboxManager(provider, lookup());
  await assert.rejects(() => manager.execute({
    auth: authContextFromUser(user(USER_A)), threadId: THREAD, command: 'echo', args: ['x'],
  }), /配额|写入/);
  assert.equal(provider.ensureRunningCalls, 0);
});
