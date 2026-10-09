import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import type { ApiRoute } from '@mastra/core/server';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import { createFileRoutes } from '../src/mastra/files/routes';
import { FileService } from '../src/mastra/files/service';
import { disabledNativeFilesystemTools } from '../src/mastra/files/policy';
import { userFileTools } from '../src/mastra/files/tools';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const THREAD_A = 'thread-a1';
const THREAD_B = 'thread-b1';
const MASTRA_USER_KEY = 'mastra__user';

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

function lookup() {
  const threads = [
    { id: THREAD_A, resourceId: USER_A },
    { id: THREAD_B, resourceId: USER_B },
  ];
  return {
    getThreadById: async ({ threadId }: { threadId: string }) =>
      threads.find(thread => thread.id === threadId) ?? null,
  };
}

function buildApp(routes: ApiRoute[]) {
  const app = new Hono();
  for (const route of routes) {
    if (!('handler' in route) || !route.handler) throw new Error(`route ${route.path} has no handler`);
    const handler = route.handler;
    app.on(route.method, route.path, async (c, next) => {
      const requestContext = new RequestContext();
      c.set('requestContext', requestContext);
      if (route.requiresAuth !== false) {
        const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? '';
        if (token === 'a') requestContext.set(MASTRA_USER_KEY, user(USER_A));
        else if (token === 'b') requestContext.set(MASTRA_USER_KEY, user(USER_B));
        else if (token === 'forged') requestContext.set('userId', USER_A);
        else return c.json({ error: 'Unauthorized' }, 401);
      }
      return handler(c, next);
    });
  }
  return app;
}

async function withRoot<T>(run: (app: Hono) => Promise<T>): Promise<T> {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'files-'));
  process.env.USER_FILES_ENABLED = 'true';
  process.env.WORKSPACE_MAX_FILE_SIZE_BYTES = '1024';
  const routes = createFileRoutes(lookup());
  return run(buildApp(routes));
}

test('anonymous file API requests are 401', async () => {
  await withRoot(async app => {
    assert.equal((await app.request(`/user-files/${THREAD_A}`)).status, 401);
    assert.equal((await app.request(`/user-files/upload`, { method: 'POST' })).status, 401);
  });
});

test('user B cannot read user A files and forged identity is ignored', async () => {
  await withRoot(async app => {
    const service = new FileService(lookup());
    await service.write(authContextFromUser(user(USER_A)), THREAD_A, 'note.txt', Buffer.from('secret'));
    const denied = await app.request(`/user-files/${THREAD_A}/note.txt`, {
      headers: { authorization: 'Bearer b' },
    });
    assert.ok(denied.status === 403 || denied.status === 404);
    const forged = await app.request(`/user-files/${THREAD_A}/note.txt`, {
      headers: { authorization: 'Bearer forged' },
    });
    assert.equal(forged.status, 401);
  });
});

test('illegal relative paths are rejected', async () => {
  await withRoot(async app => {
    const form = new FormData();
    form.set('threadId', THREAD_A);
    form.set('path', '../secret.txt');
    form.set('file', new File(['x'], 'secret.txt'));
    const response = await app.request('/user-files/upload', {
      method: 'POST',
      headers: { authorization: 'Bearer a' },
      body: form,
    });
    assert.equal(response.status, 400);
  });
});

test('download returns the file bytes and safe headers', async () => {
  await withRoot(async app => {
    const service = new FileService(lookup());
    await service.write(authContextFromUser(user(USER_A)), THREAD_A, 'out/hello.txt', Buffer.from('hello'));
    const response = await app.request(`/user-files/${THREAD_A}/out/hello.txt`, {
      headers: { authorization: 'Bearer a' },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'hello');
    assert.match(response.headers.get('content-disposition') ?? '', /hello\.txt/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const listed = await app.request(`/user-files/${THREAD_A}`, {
      headers: { authorization: 'Bearer a' },
    });
    assert.equal(listed.status, 200);
    const body = await listed.json() as { files: Array<{ path: string }> };
    assert.ok(body.files.some(file => file.path === 'out/hello.txt'));
  });
});

test('an aborted upload leaves no leftover in the thread directory', async () => {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'files-abort-'));
  const service = new FileService(lookup());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    service.write(authContextFromUser(user(USER_A)), THREAD_A, 'big.bin', Buffer.from('data'), {
      signal: controller.signal,
    }));
  const root = join(process.env.WORKSPACE_ROOT!, 'users', USER_A, 'workspace', 'threads', THREAD_A);
  const leftover = await readdir(root, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.equal(leftover.filter(name => !['input', 'output', 'tmp', 'shared', 'uploads', 'projects'].includes(String(name))
    && !String(name).endsWith('/')).length, 0);
});

test('native workspace filesystem tools are disabled and file tools go through FileService', () => {
  for (const name of Object.values(WORKSPACE_TOOLS.FILESYSTEM)) {
    assert.equal(disabledNativeFilesystemTools[name]?.enabled, false, name);
  }
  assert.ok(userFileTools.read_file);
  assert.ok(userFileTools.write_file);
  assert.ok(userFileTools.list_files);
  assert.ok(userFileTools.delete_file);
});

test('custom file routes stay outside Mastra reserved api prefix', () => {
  for (const route of createFileRoutes(lookup())) {
    assert.ok(!route.path.startsWith('/api/'), route.path);
  }
});

test('thread upload rejects oversized bodies with FILE_TOO_LARGE before writing', async () => {
  await withRoot(async app => {
    const form = new FormData();
    form.set('threadId', THREAD_A);
    form.set('path', 'huge.bin');
    form.set('file', new File(['x'.repeat(1025)], 'huge.bin'));
    const response = await app.request('/user-files/upload', {
      method: 'POST',
      headers: { authorization: 'Bearer a' },
      body: form,
    });
    assert.equal(response.status, 413);
    const body = await response.json() as { error?: string; code?: string };
    assert.equal(body.code, 'FILE_TOO_LARGE');
    const leftover = await readdir(join(process.env.WORKSPACE_ROOT!, 'temp'), { recursive: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    assert.equal(leftover.filter(name => !String(name).endsWith('/')).length, 0);
  });
});

test('thread upload maps quota failures to WORKSPACE_QUOTA_EXCEEDED JSON', async () => {
  const previous = {
    root: process.env.WORKSPACE_ROOT,
    enabled: process.env.USER_FILES_ENABLED,
    max: process.env.WORKSPACE_MAX_FILE_SIZE_BYTES,
    quota: process.env.WORKSPACE_DEFAULT_QUOTA_BYTES,
    database: process.env.DATABASE_URL,
  };
  const USER_Q = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const THREAD_Q = 'thread-q1';
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'files-quota-'));
  process.env.USER_FILES_ENABLED = 'true';
  process.env.WORKSPACE_MAX_FILE_SIZE_BYTES = '1024';
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '8';
  delete process.env.DATABASE_URL;
  try {
    const routes = createFileRoutes({
      getThreadById: async ({ threadId }: { threadId: string }) =>
        threadId === THREAD_Q ? { id: THREAD_Q, resourceId: USER_Q } : null,
    });
    const app = new Hono();
    for (const route of routes) {
      if (!('handler' in route) || !route.handler) throw new Error(`route ${route.path} has no handler`);
      const handler = route.handler;
      app.on(route.method, route.path, async (c, next) => {
        const requestContext = new RequestContext();
        c.set('requestContext', requestContext);
        if (c.req.header('authorization') === 'Bearer q') {
          requestContext.set(MASTRA_USER_KEY, user(USER_Q));
        } else {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        return handler(c, next);
      });
    }
    const form = new FormData();
    form.set('threadId', THREAD_Q);
    form.set('path', 'note.txt');
    form.set('file', new File(['0123456789'], 'note.txt'));
    const response = await app.request('/user-files/upload', {
      method: 'POST',
      headers: { authorization: 'Bearer q' },
      body: form,
    });
    assert.equal(response.status, 413);
    const body = await response.json() as { error?: string; code?: string };
    assert.equal(body.code, 'WORKSPACE_QUOTA_EXCEEDED');
  } finally {
    if (previous.root === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previous.root;
    if (previous.enabled === undefined) delete process.env.USER_FILES_ENABLED;
    else process.env.USER_FILES_ENABLED = previous.enabled;
    if (previous.max === undefined) delete process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
    else process.env.WORKSPACE_MAX_FILE_SIZE_BYTES = previous.max;
    if (previous.quota === undefined) delete process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
    else process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = previous.quota;
    if (previous.database === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.database;
  }
});
