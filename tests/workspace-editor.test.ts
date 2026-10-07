import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFilesystem } from '@mastra/core/workspace';
import { readWorkspaceVersion, saveWorkspaceText, WorkspaceEditError } from '../src/mastra/files/workspace-editor';
import { workspaceQuota } from '../src/mastra/workspace/quota';

async function fixture(content = 'before') {
  const root = await mkdtemp(join(tmpdir(), 'workspace-editor-'));
  const path = join(root, 'note.md');
  await writeFile(path, content);
  return { path, filesystem: new LocalFilesystem({ basePath: root, contained: true }) };
}

test('saves an existing text file only when its ETag matches', async () => {
  const { path, filesystem } = await fixture();
  const etag = readWorkspaceVersion(Buffer.from('before'));
  const next = await saveWorkspaceText(filesystem, 'note.md', 'after', etag);
  assert.equal(await readFile(path, 'utf8'), 'after');
  assert.equal(next, readWorkspaceVersion(Buffer.from('after')));
  await assert.rejects(() => saveWorkspaceText(filesystem, 'note.md', 'stale', etag),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 412);
  assert.equal(await readFile(path, 'utf8'), 'after');
});

test('matches the raw UTF-8 bytes of existing non-ASCII text', async () => {
  const { path, filesystem } = await fixture('中文 😀');
  const etag = readWorkspaceVersion(Buffer.from('中文 😀'));
  const next = await saveWorkspaceText(filesystem, 'note.md', '修改后 😀', etag);
  assert.equal(await readFile(path, 'utf8'), '修改后 😀');
  assert.equal(next, readWorkspaceVersion(Buffer.from('修改后 😀')));
});

test('rejects missing, binary, invalid and oversized text without creating or changing files', async () => {
  const { filesystem } = await fixture();
  const etag = readWorkspaceVersion(Buffer.from('before'));
  await assert.rejects(() => saveWorkspaceText(filesystem, 'missing.md', 'new', etag),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 404);
  await filesystem.writeFile('binary.bin', Buffer.from([0, 1, 2]));
  await assert.rejects(() => saveWorkspaceText(filesystem, 'binary.bin', 'text',
    readWorkspaceVersion(Buffer.from([0, 1, 2]))),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 409);
  await assert.rejects(() => saveWorkspaceText(filesystem, 'note.md', 'bad\0text', etag),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 400);
  await assert.rejects(() => saveWorkspaceText(filesystem, 'note.md', 'x'.repeat(10 * 1024 * 1024 + 1), etag),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 413);
});

test('a larger edit respects the user workspace quota', async () => {
  const { path, filesystem } = await fixture();
  const userId = '33333333-3333-4333-8333-333333333333';
  const previousRoot = process.env.WORKSPACE_ROOT;
  const previousQuota = process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
  process.env.WORKSPACE_ROOT = filesystem.basePath;
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '8';
  try {
    await workspaceQuota.reconcileUsage(userId, 6, 1);
    await assert.rejects(() => saveWorkspaceText(filesystem, 'note.md', 'much longer',
      readWorkspaceVersion(Buffer.from('before')), userId),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 413);
    assert.equal(await readFile(path, 'utf8'), 'before');
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
    if (previousQuota === undefined) delete process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
    else process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = previousQuota;
  }
});
