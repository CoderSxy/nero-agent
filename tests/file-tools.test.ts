import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { userFileTools } from '../src/mastra/files/tools';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const THREAD_ID = 'thread-a1';

function toolContext(threadId?: string) {
  const requestContext = new RequestContext();
  requestContext.set('mastra__user', { id: USER_ID, email: 'a@example.test', displayName: 'a', roles: ['user'] });
  return {
    requestContext,
    mastra: { getAgent: () => ({ getMemory: async () => ({
      getThreadById: async ({ threadId: id }: { threadId: string }) =>
        id === THREAD_ID ? { id, resourceId: USER_ID } : null,
    }) }) },
    agent: threadId ? { threadId } : undefined,
  } as never;
}

test('file tool writes into the authenticated agent thread without a model-supplied threadId', async () => {
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'agent-file-tool-'));
  try {
    const input = { path: 'reports/result.md', content: '# Saved' };
    assert.equal((userFileTools.write_file.inputSchema as { safeParse(value: unknown): { success: boolean } })
      .safeParse(input).success, true);
    const result = await userFileTools.write_file.execute!(input as never, toolContext(THREAD_ID));
    assert.deepEqual(result, { path: `/user-files/${THREAD_ID}/reports/result.md` });
    assert.equal(await readFile(join(process.env.WORKSPACE_ROOT, 'users', USER_ID, 'workspace',
      'threads', THREAD_ID, 'reports', 'result.md'), 'utf8'), '# Saved');
    const html = { path: 'reports/result.html', content: '<h1>Saved</h1>' };
    await userFileTools.write_file.execute!(html as never, toolContext(THREAD_ID));
    assert.equal(await readFile(join(process.env.WORKSPACE_ROOT, 'users', USER_ID, 'workspace',
      'threads', THREAD_ID, 'reports', 'result.html'), 'utf8'), html.content);
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('file tool rejects execution without a trusted agent thread', async () => {
  await assert.rejects(() => userFileTools.write_file.execute!(
    { path: 'result.html', content: '<h1>test</h1>' } as never, toolContext(),
  ), /thread/i);
});

test('file tool rejects a write one byte over the 10 MiB limit', async () => {
  const previousRoot = process.env.WORKSPACE_ROOT;
  const previousMax = process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
  const previousWarn = process.env.WORKSPACE_DISK_WARN_RATIO;
  const previousBlock = process.env.WORKSPACE_DISK_BLOCK_RATIO;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'agent-file-tool-max-'));
  process.env.WORKSPACE_DISK_WARN_RATIO = '1';
  process.env.WORKSPACE_DISK_BLOCK_RATIO = '1';
  delete process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
  try {
    await assert.rejects(
      () => userFileTools.write_file.execute!(
        { path: 'huge.txt', content: 'x'.repeat(10 * 1024 * 1024 + 1) } as never,
        toolContext(THREAD_ID),
      ),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FILE_TOO_LARGE',
    );
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
    if (previousMax === undefined) delete process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
    else process.env.WORKSPACE_MAX_FILE_SIZE_BYTES = previousMax;
    if (previousWarn === undefined) delete process.env.WORKSPACE_DISK_WARN_RATIO;
    else process.env.WORKSPACE_DISK_WARN_RATIO = previousWarn;
    if (previousBlock === undefined) delete process.env.WORKSPACE_DISK_BLOCK_RATIO;
    else process.env.WORKSPACE_DISK_BLOCK_RATIO = previousBlock;
  }
});
