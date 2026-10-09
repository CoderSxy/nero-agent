import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import { FileServiceError } from '../src/mastra/files/service';
import { WorkspaceFileService } from '../src/mastra/files/workspace-service';
import { QuotaExceededError, workspaceQuota } from '../src/mastra/workspace/quota';
import { workspaceRoot } from '../src/mastra/workspace/path';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_Q = 'abababab-abab-4aba-8bab-abababababab';

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

async function withWorkspace<T>(run: (root: string) => Promise<T>): Promise<T> {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT', 'WORKSPACE_MAX_FILE_SIZE_BYTES',
    'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'ws-files-'));
  try {
    return await run(process.env.WORKSPACE_ROOT);
  } finally {
    restoreEnv(env);
  }
}

test('uploading the same name twice stores distinct paths and does not overwrite', async () => {
  await withWorkspace(async () => {
    const service = new WorkspaceFileService();
    const auth = authContextFromUser(user(USER_A));
    const first = await service.upload(auth, new File(['one'], 'report.pdf', { type: 'application/pdf' }));
    const second = await service.upload(auth, new File(['two'], 'report.pdf', { type: 'application/pdf' }));
    assert.equal(first.source, 'personal');
    assert.equal(first.name, 'report.pdf');
    assert.match(first.path, /^uploads\/[0-9a-f-]{36}\/report\.pdf$/i);
    assert.notEqual(first.path, second.path);
    const listed = await service.list(auth);
    assert.equal(listed.files.filter(entry => entry.path === first.path || entry.path === second.path).length, 2);
  });
});

test('Unicode and special-character names stay safe path segments', async () => {
  await withWorkspace(async () => {
    const service = new WorkspaceFileService();
    const auth = authContextFromUser(user(USER_A));
    const uploaded = await service.upload(auth, new File(['hi'], '说明 文档 #1%.txt', { type: 'text/plain' }));
    assert.equal(uploaded.name, '说明 文档 #1%.txt');
    assert.match(uploaded.path, /^uploads\/[0-9a-f-]{36}\/说明 文档 #1%\.txt$/i);
    assert.equal(uploaded.mimeType, 'text/plain');
    assert.ok(uploaded.etag);
    assert.doesNotMatch(uploaded.path, /\.\.|\\|\0/);
  });
});

test('uploads larger than 10 MiB are rejected without leftover temp files', async () => {
  await withWorkspace(async root => {
    process.env.WORKSPACE_MAX_FILE_SIZE_BYTES = '100';
    const service = new WorkspaceFileService();
    const auth = authContextFromUser(user(USER_A));
    await assert.rejects(
      () => service.upload(auth, new File(['x'.repeat(101)], 'big.bin')),
      (error: unknown) => error instanceof FileServiceError && error.code === 'FILE_TOO_LARGE',
    );
    const leftover = await readdir(join(root, 'temp'), { recursive: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert.equal(leftover.filter(name => !String(name).endsWith('/')).length, 0);
    const uploads = await readdir(join(workspaceRoot(USER_A), 'uploads'), { recursive: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    assert.equal(uploads.filter(name => name !== '.' && !String(name).endsWith('/')).length, 0);
  });
});

test('uploads that exceed workspace quota return WORKSPACE_QUOTA_EXCEEDED', async () => {
  await withWorkspace(async () => {
    process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '20';
    const service = new WorkspaceFileService();
    const auth = authContextFromUser(user(USER_Q));
    await service.upload(auth, new File(['abcdefghij'], 'a.txt'));
    await assert.rejects(
      () => service.upload(auth, new File(['abcdefghijklm'], 'b.txt')),
      (error: unknown) => error instanceof QuotaExceededError && error.code === 'WORKSPACE_QUOTA_EXCEEDED',
    );
  });
});

test('list reconcile does not drop reserved-but-not-yet-on-disk quota', async () => {
  await withWorkspace(async () => {
    process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '50';
    const service = new WorkspaceFileService();
    const id = 'cdcdcdcd-cdcd-4cdc-8dcd-cdcdcdcdcdcd';
    const auth = authContextFromUser(user(id));
    await workspaceQuota.reserve(id, 40, 1);
    const listed = await service.list(auth);
    assert.equal(listed.usage.usedBytes, 40);
    assert.equal(listed.usage.fileCount, 1);
    await assert.rejects(
      () => service.upload(auth, new File(['x'.repeat(20)], 'overflow.txt')),
      QuotaExceededError,
    );
  });
});

test('list reports recursive directory sizes and personal usage', async () => {
  await withWorkspace(async () => {
    const service = new WorkspaceFileService();
    const id = 'aeaeaeae-aeae-4aea-8eae-aeaeaeaeaeae';
    const auth = authContextFromUser(user(id));
    const root = workspaceRoot(id);
    await mkdir(join(root, 'projects', 'nested'), { recursive: true });
    await writeFile(join(root, 'projects', 'a.txt'), 'aaaaa');
    await writeFile(join(root, 'projects', 'nested', 'b.txt'), 'bbbbbbb');
    const listed = await service.list(auth);
    const projects = listed.files.find(entry => entry.path === 'projects');
    const nested = listed.files.find(entry => entry.path === 'projects/nested');
    assert.equal(projects?.type, 'directory');
    assert.equal(projects?.size, 12);
    assert.equal(nested?.type, 'directory');
    assert.equal(nested?.size, 7);
    assert.equal(listed.usage.usedBytes, 12);
    assert.equal(listed.usage.fileCount, 2);
    assert.equal(listed.usage.quotaBytes, 500 * 1024 * 1024);
  });
});

test('personal usage ignores other users and does not follow symlinks', async () => {
  await withWorkspace(async () => {
    const service = new WorkspaceFileService();
    const authA = authContextFromUser(user(USER_A));
    const authB = authContextFromUser(user(USER_B));
    await service.upload(authA, new File(['secret'], 'own.txt'));
    const listedB = await service.list(authB);
    assert.ok(!listedB.files.some(entry => entry.path.endsWith('own.txt')));
    assert.equal(listedB.usage.usedBytes, 0);

    const outside = join(process.env.WORKSPACE_ROOT!, 'outside.bin');
    await writeFile(outside, 'x'.repeat(50));
    const rootA = workspaceRoot(USER_A);
    await symlink(outside, join(rootA, 'trap.bin'));
    const listedA = await service.list(authA);
    assert.ok(!listedA.files.some(entry => entry.path === 'trap.bin'));
    assert.ok(listedA.usage.usedBytes < 50);
    assert.equal((await lstat(join(rootA, 'trap.bin'))).isSymbolicLink(), true);
  });
});
