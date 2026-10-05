import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import { FileService } from '../src/mastra/files/service';
import { ensureThreadDirectory } from '../src/mastra/workspace/manager';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const THREAD_1 = 'thread-one';
const THREAD_2 = 'thread-two';

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

function lookup() {
  return {
    getThreadById: async ({ threadId }: { threadId: string }) => {
      if (threadId === THREAD_1 || threadId === THREAD_2) return { id: threadId, resourceId: USER_A };
      return null;
    },
  };
}

test('two threads of the same user can keep the same filename without overwriting', async () => {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'thread-dir-'));
  const service = new FileService(lookup());
  const auth = authContextFromUser(user(USER_A));
  await service.write(auth, THREAD_1, 'analysis.py', Buffer.from('one'));
  await service.write(auth, THREAD_2, 'analysis.py', Buffer.from('two'));
  assert.equal((await service.read(auth, THREAD_1, 'analysis.py')).data.toString(), 'one');
  assert.equal((await service.read(auth, THREAD_2, 'analysis.py')).data.toString(), 'two');
});

test('deleting a thread record does not delete its directory', async () => {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'thread-keep-'));
  const auth = authContextFromUser(user(USER_A));
  const created = await ensureThreadDirectory(auth, THREAD_1, lookup());
  await serviceWrite();
  async function serviceWrite() {
    await new FileService(lookup()).write(auth, THREAD_1, 'keep.txt', Buffer.from('keep'));
  }
  const hostPath = join(created.hostPath, 'keep.txt');
  assert.equal(created.containerPath, `/workspace/threads/${THREAD_1}`);
  await rm(join(process.env.WORKSPACE_ROOT!, 'gone'), { force: true });
  assert.equal((await readFile(hostPath)).toString(), 'keep');
});

test('ensureThreadDirectory rejects another user threadId', async () => {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'thread-deny-'));
  await assert.rejects(
    () => ensureThreadDirectory(authContextFromUser(user(USER_B)), THREAD_1, lookup()),
  );
});
