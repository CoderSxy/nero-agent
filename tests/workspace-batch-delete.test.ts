import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import { FileServiceError } from '../src/mastra/files/service';
import { WorkspaceFileService } from '../src/mastra/files/workspace-service';
import * as fileRoutes from '../src/mastra/files/routes';
import { ensureUserWorkspace } from '../src/mastra/workspace/manager';
import { workspaceQuota } from '../src/mastra/workspace/quota';
import { workspaceRoot } from '../src/mastra/workspace/path';

const USER_A = 'a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7';
const USER_B = 'b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7';
const THREAD = 't7t7t7t7-t7t7-4t7t-8t7t-t7t7t7t7t7t7';

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function user(id: string, roles: AuthUser['roles'] = ['user']): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles };
}

async function withWorkspace<T>(run: () => Promise<T>): Promise<T> {
  const env = snapshotEnv([
    'DATABASE_URL', 'WORKSPACE_ROOT', 'WORKSPACE_DEFAULT_QUOTA_BYTES', 'USER_FILES_ENABLED',
  ]);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'ws-batch-del-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = String(10 * 1024 * 1024);
  process.env.USER_FILES_ENABLED = 'true';
  try {
    return await run();
  } finally {
    restoreEnv(env);
  }
}

async function seedPersonalTree(userId: string) {
  const auth = authContextFromUser(user(userId));
  const root = await ensureUserWorkspace(auth);
  await mkdir(join(root, 'uploads', 'dir-a'), { recursive: true });
  await writeFile(join(root, 'uploads', 'dir-a', 'child.txt'), 'child-bytes');
  await writeFile(join(root, 'uploads', 'alone.txt'), 'alone!!');
  await mkdir(join(root, 'projects', 'keep'), { recursive: true });
  await writeFile(join(root, 'projects', 'keep', 'note.txt'), 'note');
  await mkdir(join(root, 'threads', THREAD, 'input'), { recursive: true });
  await mkdir(join(root, 'threads', THREAD, 'output'), { recursive: true });
  await mkdir(join(root, 'threads', THREAD, 'tmp'), { recursive: true });
  await writeFile(join(root, 'threads', THREAD, 'input', 'in.txt'), 'in-data');
  await writeFile(join(root, 'threads', THREAD, 'output', 'out.txt'), 'out!!');
  await workspaceQuota.reconcileFromDisk(userId);
  return { auth, root };
}

test('deleting a file releases its quota bytes and file count', async () => {
  await withWorkspace(async () => {
    const service = new WorkspaceFileService();
    const { auth } = await seedPersonalTree(USER_A);
    const before = await workspaceQuota.usage(USER_A);
    const result = await service.batchDelete(auth, ['uploads/alone.txt']);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.ok, true);
    assert.equal(result.deletedFiles, 1);
    assert.equal(result.freedBytes, 7);
    assert.equal(result.usage.usedBytes, before.usedBytes - 7);
    assert.equal(result.usage.fileCount, before.fileCount - 1);
    assert.equal((await workspaceQuota.usage(USER_A)).usedBytes, result.usage.usedBytes);
  });
});

test('deleting a directory recursively frees descendant regular-file bytes once', async () => {
  await withWorkspace(async () => {
    const service = new WorkspaceFileService();
    const { auth } = await seedPersonalTree(USER_A);
    const before = await workspaceQuota.usage(USER_A);
    const result = await service.batchDelete(auth, ['uploads/dir-a']);
    assert.equal(result.results[0]?.ok, true);
    assert.equal(result.deletedFiles, 1);
    assert.equal(result.freedBytes, 11);
    assert.equal(result.usage.usedBytes, before.usedBytes - 11);
  });
});

test('parent and child paths collapse so freed bytes are not double-counted', async () => {
  await withWorkspace(async () => {
    const service = new WorkspaceFileService();
    const { auth } = await seedPersonalTree(USER_A);
    const before = await workspaceQuota.usage(USER_A);
    const result = await service.batchDelete(auth, [
      'uploads/dir-a',
      'uploads/dir-a/child.txt',
      'uploads/dir-a/child.txt',
    ]);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.path, 'uploads/dir-a');
    assert.equal(result.results[0]?.ok, true);
    assert.equal(result.deletedFiles, 1);
    assert.equal(result.freedBytes, 11);
    assert.equal(result.usage.usedBytes, before.usedBytes - 11);
  });
});

test('protected workspace roots and thread input/output/tmp roots are rejected', async () => {
  await withWorkspace(async () => {
    const service = new WorkspaceFileService();
    const { auth } = await seedPersonalTree(USER_A);
    const before = await workspaceQuota.usage(USER_A);
    const top = await service.batchDelete(auth, ['shared', 'uploads', 'projects', 'threads']);
    assert.equal(top.results.length, 4);
    assert.ok(top.results.every(item => item.ok === false && item.errorCode === 'PROTECTED_PATH'));

    const leaves = await service.batchDelete(auth, [
      `threads/${THREAD}/input`,
      `threads/${THREAD}/output`,
      `threads/${THREAD}/tmp`,
    ]);
    assert.equal(leaves.results.length, 3);
    assert.ok(leaves.results.every(item => item.ok === false && item.errorCode === 'PROTECTED_PATH'));
    assert.equal(leaves.deletedFiles, 0);
    assert.equal(leaves.freedBytes, 0);
    assert.equal(leaves.usage.usedBytes, before.usedBytes);
    await access(join(workspaceRoot(USER_A), 'shared'));
    await access(join(workspaceRoot(USER_A), 'threads', THREAD, 'input'));
  });
});

test('deleting a thread workspace root is rejected and preserves input/output/tmp', async () => {
  await withWorkspace(async () => {
    const service = new WorkspaceFileService();
    const { auth } = await seedPersonalTree(USER_A);
    const before = await workspaceQuota.usage(USER_A);
    const result = await service.batchDelete(auth, [`threads/${THREAD}`]);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.path, `threads/${THREAD}`);
    assert.equal(result.results[0]?.ok, false);
    assert.equal(result.results[0]?.errorCode, 'PROTECTED_PATH');
    assert.equal(result.deletedFiles, 0);
    assert.equal(result.freedBytes, 0);
    assert.equal(result.usage.usedBytes, before.usedBytes);
    const root = workspaceRoot(USER_A);
    await access(join(root, 'threads', THREAD, 'input', 'in.txt'));
    await access(join(root, 'threads', THREAD, 'output', 'out.txt'));
    await access(join(root, 'threads', THREAD, 'tmp'));
  });
});

test('rejects empty arrays, more than 100 top-level paths, traversal, and symlinks', async () => {
  await withWorkspace(async () => {
    const service = new WorkspaceFileService();
    const { auth, root } = await seedPersonalTree(USER_A);
    await assert.rejects(() => service.batchDelete(auth, []), FileServiceError);
    await assert.rejects(
      () => service.batchDelete(auth, Array.from({ length: 101 }, (_, i) => `uploads/f-${i}.txt`)),
      FileServiceError,
    );
    const traversal = await service.batchDelete(auth, ['uploads/../projects/keep/note.txt']);
    assert.equal(traversal.results[0]?.ok, false);
    assert.ok(traversal.results[0]?.errorCode);

    const outside = join(process.env.WORKSPACE_ROOT!, 'outside.bin');
    await writeFile(outside, 'linked');
    await symlink(outside, join(root, 'uploads', 'link.bin'));
    const linked = await service.batchDelete(auth, ['uploads/link.bin']);
    assert.equal(linked.results[0]?.ok, false);
    assert.equal(linked.deletedFiles, 0);
    assert.equal(linked.freedBytes, 0);
  });
});

test('partial failure reports per-item results and only frees successful deletes', async () => {
  await withWorkspace(async () => {
    const service = new WorkspaceFileService();
    const { auth } = await seedPersonalTree(USER_A);
    const before = await workspaceQuota.usage(USER_A);
    const result = await service.batchDelete(auth, [
      'uploads/alone.txt',
      'shared',
      'projects/keep/note.txt',
      'missing/nope.txt',
    ]);
    const byPath = Object.fromEntries(result.results.map(item => [item.path, item]));
    assert.equal(byPath['uploads/alone.txt']?.ok, true);
    assert.equal(byPath.shared?.ok, false);
    assert.equal(byPath.shared?.errorCode, 'PROTECTED_PATH');
    assert.equal(byPath['projects/keep/note.txt']?.ok, true);
    assert.equal(byPath['missing/nope.txt']?.ok, false);
    assert.equal(result.deletedFiles, 2);
    assert.equal(result.freedBytes, 7 + 4);
    assert.equal(result.usage.usedBytes, before.usedBytes - 11);
    assert.equal((await workspaceQuota.usage(USER_A)).usedBytes, result.usage.usedBytes);
    assert.equal((await workspaceQuota.usage(USER_A)).fileCount, result.usage.fileCount);
  });
});

test('collapsed parent+child batch reports one result when parent fails', async () => {
  await withWorkspace(async () => {
    const service = new WorkspaceFileService();
    const { auth } = await seedPersonalTree(USER_A);
    const before = await workspaceQuota.usage(USER_A);
    const result = await service.batchDelete(auth, [
      'uploads',
      'uploads/alone.txt',
      'uploads/dir-a/child.txt',
    ]);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.path, 'uploads');
    assert.equal(result.results[0]?.ok, false);
    assert.equal(result.results[0]?.errorCode, 'PROTECTED_PATH');
    assert.equal(result.deletedFiles, 0);
    assert.equal(result.freedBytes, 0);
    assert.equal(result.usage.usedBytes, before.usedBytes);
  });
});

test('batch-delete route is personal-only and rejects source=agent and anonymous callers', async () => {
  await withWorkspace(async () => {
    await seedPersonalTree(USER_A);
    const app = new Hono();
    const createRoutes = (fileRoutes as unknown as {
      createCurrentWorkspaceFileRoutes: () => ApiRoute[];
    }).createCurrentWorkspaceFileRoutes;
    for (const route of createRoutes()) {
      if (!('handler' in route) || !route.handler) continue;
      const handler = route.handler;
      app.on(route.method, route.path, async (c, next) => {
        const requestContext = new RequestContext();
        const token = c.req.header('authorization')?.replace(/^Bearer /i, '');
        if (token === 'user') {
          requestContext.set('mastra__user', user(USER_A));
        }
        if (token === 'other') {
          requestContext.set('mastra__user', user(USER_B));
        }
        c.set('requestContext', requestContext);
        return handler(c, next);
      });
    }

    assert.equal((await app.request('/current-workspace/files/batch-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['uploads/alone.txt'] }),
    })).status, 401);

    assert.equal((await app.request('/current-workspace/files/batch-delete?source=agent', {
      method: 'POST',
      headers: {
        authorization: 'Bearer user',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ paths: ['uploads/alone.txt'] }),
    })).status, 403);

    const ok = await app.request('/current-workspace/files/batch-delete', {
      method: 'POST',
      headers: {
        authorization: 'Bearer user',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ paths: ['uploads/alone.txt'] }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json() as {
      deletedFiles: number;
      freedBytes: number;
      results: Array<{ path: string; ok: boolean }>;
      usage: { usedBytes: number; fileCount: number };
    };
    assert.equal(body.deletedFiles, 1);
    assert.equal(body.freedBytes, 7);
    assert.equal(body.results[0]?.ok, true);

    const cross = await app.request('/current-workspace/files/batch-delete', {
      method: 'POST',
      headers: {
        authorization: 'Bearer other',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ paths: ['uploads/alone.txt'] }),
    });
    assert.equal(cross.status, 200);
    const crossBody = await cross.json() as { deletedFiles: number; results: Array<{ ok: boolean }> };
    assert.equal(crossBody.deletedFiles, 0);
    assert.equal(crossBody.results[0]?.ok, false);
  });
});
