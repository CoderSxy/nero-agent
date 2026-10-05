import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { authContextFromUser, trustedAuth } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import { FileService } from '../src/mastra/files/service';
import { FakeSandboxProvider } from '../src/mastra/sandbox/fake-provider';
import { SandboxManager } from '../src/mastra/sandbox/manager';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

function lookup() {
  return {
    getThreadById: async ({ threadId }: { threadId: string }) => {
      if (threadId.startsWith('a-')) return { id: threadId, resourceId: USER_A };
      if (threadId.startsWith('b-')) return { id: threadId, resourceId: USER_B };
      return null;
    },
  };
}

test('two users with two threads cannot read each other files or run as another identity', async () => {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'e2e-ws-'));
  process.env.SANDBOX_COMMANDS_ENABLED = 'true';
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = String(500 * 1024 * 1024);
  const service = new FileService(lookup());
  const authA = authContextFromUser(user(USER_A));
  const authB = authContextFromUser(user(USER_B));
  await service.write(authA, 'a-1', 'analysis.py', Buffer.from('a1'));
  await service.write(authA, 'a-2', 'analysis.py', Buffer.from('a2'));
  await service.write(authB, 'b-1', 'analysis.py', Buffer.from('b1'));
  assert.equal((await service.read(authA, 'a-1', 'analysis.py')).data.toString(), 'a1');
  assert.equal((await service.read(authA, 'a-2', 'analysis.py')).data.toString(), 'a2');
  await assert.rejects(() => service.read(authB, 'a-1', 'analysis.py'));
  const ctx = new RequestContext();
  ctx.set('mastra__user', user(USER_A));
  ctx.set('userId', USER_B);
  assert.equal(trustedAuth(ctx).userId, USER_A);
  const provider = new FakeSandboxProvider();
  const manager = new SandboxManager(provider, lookup());
  await manager.execute({ auth: authA, threadId: 'a-1', command: 'echo', args: ['ok'] });
  assert.equal(provider.lastOwner?.userId, USER_A);
  await assert.rejects(() => manager.execute({ auth: authA, threadId: 'b-1', command: 'echo', args: ['no'] }));
});
