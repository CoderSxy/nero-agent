import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readdir, stat, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFilesystem } from '@mastra/core/workspace';
import {
  readWorkspaceVersion,
  replaceWorkspaceText,
  saveWorkspaceText,
  WorkspaceEditError,
} from '../src/mastra/files/workspace-editor';
import { workspaceQuota } from '../src/mastra/workspace/quota';

async function fixture(content: string | Buffer = 'before') {
  const root = await mkdtemp(join(tmpdir(), 'workspace-editor-'));
  const path = join(root, 'note.md');
  await writeFile(path, content);
  return { root, path, filesystem: new LocalFilesystem({ basePath: root, contained: true }) };
}

const USER_ID = '55555555-5555-4555-8555-555555555555';

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

test('editing a private file preserves its mode', async () => {
  const { path, filesystem } = await fixture('before');
  await chmod(path, 0o600);
  const etag = readWorkspaceVersion(Buffer.from('before'));
  await saveWorkspaceText(filesystem, 'note.md', 'after', etag);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
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
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 413
      && error.code === 'FILE_TOO_LARGE');
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
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 413
      && error.code === 'WORKSPACE_QUOTA_EXCEEDED');
    assert.equal(await readFile(path, 'utf8'), 'before');
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
    if (previousQuota === undefined) delete process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
    else process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = previousQuota;
  }
});

test('successful growing edit settles its quota reservation', async () => {
  const { filesystem } = await fixture();
  const userId = '44444444-4444-4444-8444-444444444444';
  const previousQuota = process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '100';
  process.env.WORKSPACE_ROOT = filesystem.basePath;
  try {
    await workspaceQuota.reconcileUsage(userId, 6, 1);
    await saveWorkspaceText(filesystem, 'note.md', 'longer text',
      readWorkspaceVersion(Buffer.from('before')), userId);
    assert.equal(workspaceQuota.hasInflightReserve(userId), false);
    assert.equal((await workspaceQuota.usage(userId)).usedBytes, 11);
  } finally {
    if (previousQuota === undefined) delete process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
    else process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = previousQuota;
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('replaceWorkspaceText replaces exactly once and returns new etag/size', async () => {
  const { path, filesystem } = await fixture('hello world');
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = filesystem.basePath!;
  try {
    const etag = readWorkspaceVersion(Buffer.from('hello world'));
    const result = await replaceWorkspaceText(filesystem, 'note.md', 'world', 'there', etag, USER_ID);
    assert.equal(await readFile(path, 'utf8'), 'hello there');
    assert.equal(result.etag, readWorkspaceVersion(Buffer.from('hello there')));
    assert.equal(result.size, Buffer.byteLength('hello there'));
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('replaceWorkspaceText allows empty newText', async () => {
  const { path, filesystem } = await fixture('keep REMOVE keep');
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = filesystem.basePath!;
  try {
    const etag = readWorkspaceVersion(Buffer.from('keep REMOVE keep'));
    const result = await replaceWorkspaceText(filesystem, 'note.md', ' REMOVE', '', etag, USER_ID);
    assert.equal(await readFile(path, 'utf8'), 'keep keep');
    assert.equal(result.size, Buffer.byteLength('keep keep'));
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('replaceWorkspaceText rejects zero, two, and overlapping matches without writing', async () => {
  for (const [content, oldText, code] of [
    ['abc', 'zz', 'NO_MATCH'],
    ['one X two X three', 'X', 'AMBIGUOUS_MATCH'],
    ['aaa', 'aa', 'AMBIGUOUS_MATCH'],
  ] as const) {
    const { path, filesystem } = await fixture(content);
    const before = await readFile(path);
    const etag = readWorkspaceVersion(before);
    await assert.rejects(
      () => replaceWorkspaceText(filesystem, 'note.md', oldText, 'Y', etag, USER_ID),
      (error: unknown) => error instanceof WorkspaceEditError && error.code === code,
    );
    assert.deepEqual(await readFile(path), before);
  }
});

test('replaceWorkspaceText rejects stale and malformed etags without writing', async () => {
  const { path, filesystem } = await fixture('stable');
  const before = await readFile(path);
  await assert.rejects(
    () => replaceWorkspaceText(filesystem, 'note.md', 'stable', 'x', '"deadbeef"', USER_ID),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 400,
  );
  await assert.rejects(
    () => replaceWorkspaceText(
      filesystem, 'note.md', 'stable', 'x',
      readWorkspaceVersion(Buffer.from('other')), USER_ID,
    ),
    (error: unknown) => error instanceof WorkspaceEditError
      && error.status === 412 && error.code === 'STALE_VERSION',
  );
  assert.deepEqual(await readFile(path), before);
});

test('replaceWorkspaceText rejects missing binary invalid-utf8 symlink oversized and NUL inputs', async () => {
  const { root, path, filesystem } = await fixture('before');
  const etag = readWorkspaceVersion(Buffer.from('before'));
  const before = await readFile(path);

  await assert.rejects(
    () => replaceWorkspaceText(filesystem, 'missing.md', 'a', 'b', etag, USER_ID),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 404,
  );

  await writeFile(join(root, 'bin.bin'), Buffer.from([0, 1, 2]));
  await assert.rejects(
    () => replaceWorkspaceText(
      filesystem, 'bin.bin', 'a', 'b',
      readWorkspaceVersion(Buffer.from([0, 1, 2])), USER_ID,
    ),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 409,
  );

  await writeFile(join(root, 'bad.txt'), Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(
    () => replaceWorkspaceText(
      filesystem, 'bad.txt', 'a', 'b',
      readWorkspaceVersion(Buffer.from([0xff, 0xfe, 0xfd])), USER_ID,
    ),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 409,
  );

  await symlink(path, join(root, 'link.md'));
  await assert.rejects(
    () => replaceWorkspaceText(filesystem, 'link.md', 'before', 'after', etag, USER_ID),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 400,
  );
  // Mutation path must not follow symlinks even if a reader would (O_NOFOLLOW).
  assert.equal(await readFile(path, 'utf8'), 'before');

  const huge = `Q${'x'.repeat(10 * 1024 * 1024 - 1)}`;
  await writeFile(join(root, 'huge.txt'), huge);
  await assert.rejects(
    () => replaceWorkspaceText(
      filesystem, 'huge.txt', 'Q', 'QQ',
      readWorkspaceVersion(Buffer.from(huge)), USER_ID,
    ),
    (error: unknown) => error instanceof WorkspaceEditError
      && error.status === 413 && error.code === 'FILE_TOO_LARGE',
  );

  const overOld = 'o'.repeat(64 * 1024 + 1);
  await assert.rejects(
    () => replaceWorkspaceText(filesystem, 'note.md', overOld, 'n', etag, USER_ID),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 400,
  );
  const overNew = 'n'.repeat(64 * 1024 + 1);
  await assert.rejects(
    () => replaceWorkspaceText(filesystem, 'note.md', 'before', overNew, etag, USER_ID),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 400,
  );
  await assert.rejects(
    () => replaceWorkspaceText(filesystem, 'note.md', '', 'x', etag, USER_ID),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 400,
  );
  await assert.rejects(
    () => replaceWorkspaceText(filesystem, 'note.md', 'be\0fore', 'x', etag, USER_ID),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 400,
  );
  await assert.rejects(
    () => replaceWorkspaceText(filesystem, 'note.md', 'before', 'a\0b', etag, USER_ID),
    (error: unknown) => error instanceof WorkspaceEditError && error.status === 400,
  );

  assert.deepEqual(await readFile(path), before);
});

test('replaceWorkspaceText rejects quota and disk protection without changing bytes or quota', async () => {
  const { path, filesystem } = await fixture('short');
  const userId = '66666666-6666-4666-8666-666666666666';
  const previousRoot = process.env.WORKSPACE_ROOT;
  const previousQuota = process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
  const previousBlock = process.env.WORKSPACE_DISK_BLOCK_RATIO;
  process.env.WORKSPACE_ROOT = filesystem.basePath!;
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '8';
  try {
    await workspaceQuota.reconcileUsage(userId, 5, 1);
    const beforeBytes = await readFile(path);
    const beforeUsage = await workspaceQuota.usage(userId);
    await assert.rejects(
      () => replaceWorkspaceText(
        filesystem, 'note.md', 'short', 'much longer text',
        readWorkspaceVersion(beforeBytes), userId,
      ),
      (error: unknown) => error instanceof WorkspaceEditError
        && error.code === 'WORKSPACE_QUOTA_EXCEEDED',
    );
    assert.deepEqual(await readFile(path), beforeBytes);
    assert.deepEqual(await workspaceQuota.usage(userId), beforeUsage);
    assert.equal(workspaceQuota.hasInflightReserve(userId), false);

    process.env.WORKSPACE_DISK_BLOCK_RATIO = '0';
    process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '1000';
    await workspaceQuota.reconcileUsage(userId, 5, 1);
    const beforeDisk = await readFile(path);
    const beforeDiskUsage = await workspaceQuota.usage(userId);
    await assert.rejects(
      () => replaceWorkspaceText(
        filesystem, 'note.md', 'short', 'longer',
        readWorkspaceVersion(beforeDisk), userId,
      ),
      (error: unknown) => error instanceof WorkspaceEditError && error.status === 409,
    );
    assert.deepEqual(await readFile(path), beforeDisk);
    assert.deepEqual(await workspaceQuota.usage(userId), beforeDiskUsage);
    assert.equal(workspaceQuota.hasInflightReserve(userId), false);
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
    if (previousQuota === undefined) delete process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
    else process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = previousQuota;
    if (previousBlock === undefined) delete process.env.WORKSPACE_DISK_BLOCK_RATIO;
    else process.env.WORKSPACE_DISK_BLOCK_RATIO = previousBlock;
  }
});

test('concurrent replaces sharing an etag yield exactly one success', async () => {
  const { path, filesystem } = await fixture('shared-token');
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = filesystem.basePath!;
  try {
    const etag = readWorkspaceVersion(Buffer.from('shared-token'));
    const results = await Promise.allSettled([
      replaceWorkspaceText(filesystem, 'note.md', 'shared-token', 'first-win', etag, USER_ID),
      replaceWorkspaceText(filesystem, 'note.md', 'shared-token', 'second-win', etag, USER_ID),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const stale = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(stale instanceof WorkspaceEditError && stale.code === 'STALE_VERSION');
    const body = await readFile(path, 'utf8');
    assert.ok(body === 'first-win' || body === 'second-win');
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('saveWorkspaceText and replaceWorkspaceText share the same path lock', async () => {
  const { path, filesystem } = await fixture('lock-me');
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = filesystem.basePath!;
  try {
    const etag = readWorkspaceVersion(Buffer.from('lock-me'));
    const results = await Promise.allSettled([
      saveWorkspaceText(filesystem, 'note.md', 'from-save', etag, USER_ID),
      replaceWorkspaceText(filesystem, 'note.md', 'lock-me', 'from-replace', etag, USER_ID),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const stale = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(stale instanceof WorkspaceEditError && (stale.status === 412 || stale.code === 'STALE_VERSION'));
    const body = await readFile(path, 'utf8');
    assert.ok(body === 'from-save' || body === 'from-replace');
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('web personal-root and agent thread-root paths serialize on the same physical file', async () => {
  const personalRoot = await mkdtemp(join(tmpdir(), 'workspace-editor-div-'));
  const threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const threadDir = join(personalRoot, 'threads', threadId);
  await mkdir(threadDir, { recursive: true });
  const hostPath = join(threadDir, 'note.md');
  await writeFile(hostPath, 'shared-token');

  const personalFs = new LocalFilesystem({ basePath: personalRoot, contained: true });
  const threadFs = new LocalFilesystem({ basePath: threadDir, contained: true });
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = personalRoot;
  try {
    const etag = readWorkspaceVersion(Buffer.from('shared-token'));
    const webPath = `threads/${threadId}/note.md`;
    const results = await Promise.allSettled([
      saveWorkspaceText(personalFs, webPath, 'from-web', etag, USER_ID),
      replaceWorkspaceText(threadFs, 'note.md', 'shared-token', 'from-agent', etag, USER_ID),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const stale = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(stale instanceof WorkspaceEditError && stale.code === 'STALE_VERSION');
    const body = await readFile(hostPath, 'utf8');
    assert.ok(body === 'from-web' || body === 'from-agent');
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('equal-size edit still enforces disk protection when userId is set', async () => {
  const { path, filesystem } = await fixture('same-sz');
  const previousRoot = process.env.WORKSPACE_ROOT;
  const previousBlock = process.env.WORKSPACE_DISK_BLOCK_RATIO;
  process.env.WORKSPACE_ROOT = filesystem.basePath!;
  process.env.WORKSPACE_DISK_BLOCK_RATIO = '0';
  try {
    const before = await readFile(path);
    const etag = readWorkspaceVersion(before);
    await assert.rejects(
      () => saveWorkspaceText(filesystem, 'note.md', 'SAME-SZ', etag, USER_ID),
      (error: unknown) => error instanceof WorkspaceEditError && error.status === 409,
    );
    assert.deepEqual(await readFile(path), before);
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
    if (previousBlock === undefined) delete process.env.WORKSPACE_DISK_BLOCK_RATIO;
    else process.env.WORKSPACE_DISK_BLOCK_RATIO = previousBlock;
  }
});

test('injected write failure leaves no temp file or pending reservation', async () => {
  const { root, path, filesystem } = await fixture('atomic');
  const userId = '77777777-7777-4777-8777-777777777777';
  const previousRoot = process.env.WORKSPACE_ROOT;
  const previousQuota = process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
  process.env.WORKSPACE_ROOT = root;
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '1000';
  try {
    await workspaceQuota.reconcileUsage(userId, 6, 1);
    const etag = readWorkspaceVersion(Buffer.from('atomic'));
    await chmod(root, 0o555);
    try {
      await assert.rejects(
        () => replaceWorkspaceText(filesystem, 'note.md', 'atomic', 'longer-atomic', etag, userId),
      );
    } finally {
      await chmod(root, 0o755);
    }
    assert.equal(await readFile(path, 'utf8'), 'atomic');
    assert.equal(workspaceQuota.hasInflightReserve(userId), false);
    const leftovers = (await readdir(root)).filter(name => name.includes('.tmp') || name.startsWith('.'));
    assert.deepEqual(leftovers.filter(name => name !== '.' && name !== '..'), []);
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
    if (previousQuota === undefined) delete process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
    else process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = previousQuota;
  }
});
