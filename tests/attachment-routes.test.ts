import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import type { ApiRoute } from '@mastra/core/server';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import { FilePathError } from '../src/mastra/files/policy';
import { FileServiceError } from '../src/mastra/files/service';
import { AttachmentService } from '../src/mastra/files/attachments';
import * as fileRoutes from '../src/mastra/files/routes';
import { WorkspaceFileService } from '../src/mastra/files/workspace-service';
import { ThreadGuardError } from '../src/mastra/auth/thread-guard';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const THREAD_A = 'thread-attach-a';
const THREAD_B = 'thread-attach-b';
const DATABASE_URL = process.env.DATABASE_URL;

function user(id: string, roles: AuthUser['roles'] = ['user']): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles };
}

function lookup() {
  return {
    getThreadById: async ({ threadId }: { threadId: string }) => {
      if (!threadId) return null;
      if (threadId === THREAD_B) return { id: threadId, resourceId: OTHER_ID };
      return { id: threadId, resourceId: USER_ID };
    },
  };
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function appWithWorkspace() {
  const agentRoot = await mkdtemp(join(tmpdir(), 'agent-attach-'));
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'user-attach-'));
  await mkdir(join(agentRoot, 'output'), { recursive: true });
  await writeFile(join(agentRoot, 'output', 'agent.txt'), 'agent-file');
  const personal = join(process.env.WORKSPACE_ROOT, 'users', USER_ID, 'workspace', 'projects');
  await mkdir(personal, { recursive: true });
  await writeFile(join(personal, 'note.txt'), 'hello-note');
  const workspace = new Workspace({
    id: 'agent-workspace',
    name: 'Agent workspace',
    filesystem: new LocalFilesystem({ basePath: agentRoot, contained: true }),
  });
  const app = new Hono();
  const createRoutes = (fileRoutes as unknown as {
    createCurrentWorkspaceFileRoutes: (lookup?: ReturnType<typeof lookup>) => ApiRoute[];
  }).createCurrentWorkspaceFileRoutes;
  for (const route of createRoutes(lookup())) {
    if (!('handler' in route) || !route.handler) throw new Error(`Missing handler: ${route.path}`);
    const handler = route.handler;
    app.on(route.method, route.path, async (c, next) => {
      const requestContext = new RequestContext();
      const token = c.req.header('authorization')?.replace(/^Bearer /i, '');
      if (token === 'admin') requestContext.set('mastra__user', user(ADMIN_ID, ['admin']));
      if (token === 'user') requestContext.set('mastra__user', user(USER_ID));
      if (token === 'other') requestContext.set('mastra__user', user(OTHER_ID));
      c.set('requestContext', requestContext);
      c.set('mastra', { getAgent: () => ({
        getWorkspace: async () => workspace,
        getMemory: async () => lookup(),
      }) });
      return handler(c, next);
    });
  }
  return { app, agentRoot };
}

async function withMemory<T>(run: () => Promise<T>): Promise<T> {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'attach-svc-'));
  try {
    return await run();
  } finally {
    restoreEnv(env);
  }
}

function service(agentRoot?: string) {
  return new AttachmentService(lookup(), {
    resolveAgentWorkspace: agentRoot
      ? async () => ({ filesystem: new LocalFilesystem({ basePath: agentRoot, contained: true }) })
      : undefined,
  });
}

test('selecting the same workspace file twice is idempotent and does not copy or grow usage', async () => {
  await withMemory(async () => {
    const files = new WorkspaceFileService();
    const auth = authContextFromUser(user(USER_ID));
    const uploaded = await files.upload(auth, new File(['payload'], 'once.txt', { type: 'text/plain' }));
    const before = await files.list(auth);
    const attachments = service();
    const first = await attachments.prepare(auth, 'thread-idempotent', 'msg-1', [
      { source: 'personal', path: uploaded.path },
      { source: 'personal', path: uploaded.path },
    ]);
    assert.equal(first.length, 1);
    const second = await attachments.prepare(auth, 'thread-idempotent', 'msg-1', [
      { source: 'personal', path: uploaded.path },
    ]);
    assert.equal(second.length, 1);
    assert.equal(second[0]!.attachmentId, first[0]!.attachmentId);
    assert.equal(second[0]!.status, 'available');
    const after = await files.list(auth);
    assert.equal(after.usage.usedBytes, before.usage.usedBytes);
    assert.equal(after.usage.fileCount, before.usage.fileCount);
    const listed = await files.list(auth);
    assert.equal(listed.files.filter(entry => entry.path === uploaded.path).length, 1);
  });
});

test('history listing keeps stored metadata after the original file is deleted or changed', async () => {
  await withMemory(async () => {
    const files = new WorkspaceFileService();
    const auth = authContextFromUser(user(USER_ID));
    const uploaded = await files.upload(auth, new File(['v1'], 'card.txt', { type: 'text/plain' }));
    const attachments = service();
    const prepared = await attachments.prepare(auth, 'thread-hist', 'msg-hist', [
      { source: 'personal', path: uploaded.path },
    ]);
    const original = prepared[0]!;
    const host = join(process.env.WORKSPACE_ROOT!, 'users', USER_ID, 'workspace', uploaded.path);
    await writeFile(host, 'v2-changed');
    const changedList = await attachments.listForThread(auth, 'thread-hist');
    const changed = changedList.find(item => item.attachmentId === original.attachmentId);
    assert.equal(changed?.name, 'card.txt');
    assert.equal(changed?.size, original.size);
    assert.equal(changed?.mimeType, original.mimeType);
    assert.equal(changed?.status, 'changed');
    const readChanged = await attachments.readOwned(auth, 'thread-hist', original.attachmentId);
    assert.equal(readChanged.ref.status, 'changed');
    assert.equal(readChanged.data.toString(), 'v2-changed');
    await unlink(host);
    const deletedList = await attachments.listForThread(auth, 'thread-hist');
    const deleted = deletedList.find(item => item.attachmentId === original.attachmentId);
    assert.equal(deleted?.name, 'card.txt');
    assert.equal(deleted?.size, original.size);
    assert.equal(deleted?.status, 'deleted');
    const readDeleted = await attachments.readOwned(auth, 'thread-hist', original.attachmentId);
    assert.equal(readDeleted.ref.status, 'deleted');
    assert.equal(readDeleted.data.byteLength, 0);
  });
});

test('forged users, other threads, unknown ids and non-admin agent source are rejected', async () => {
  await withMemory(async () => {
    const files = new WorkspaceFileService();
    const auth = authContextFromUser(user(USER_ID));
    const other = authContextFromUser(user(OTHER_ID));
    const uploaded = await files.upload(auth, new File(['secret'], 'secret.txt'));
    const attachments = service();
    const prepared = await attachments.prepare(auth, 'thread-sec', 'msg-sec', [
      { source: 'personal', path: uploaded.path },
    ]);
    const id = prepared[0]!.attachmentId;
    await assert.rejects(() => attachments.listForThread(other, 'thread-sec'), ThreadGuardError);
    await assert.rejects(() => attachments.readOwned(other, 'thread-sec', id), ThreadGuardError);
    await assert.rejects(() => attachments.readOwned(auth, THREAD_B, id), ThreadGuardError);
    await assert.rejects(
      () => attachments.readOwned(auth, 'thread-sec', '00000000-0000-4000-8000-000000000000'),
      (error: unknown) => error instanceof FileServiceError && error.status === 404,
    );
    await assert.rejects(
      () => attachments.prepare(auth, 'thread-sec', 'msg-agent', [{ source: 'agent', path: 'output/agent.txt' }]),
      (error: unknown) => error instanceof FileServiceError && error.status === 403,
    );
  });
});

test('directories, traversal, symlinks and more than ten attachments are rejected', async () => {
  await withMemory(async () => {
    const auth = authContextFromUser(user(USER_ID));
    const root = join(process.env.WORKSPACE_ROOT!, 'users', USER_ID, 'workspace');
    await mkdir(join(root, 'projects', 'empty-dir'), { recursive: true });
    await writeFile(join(root, 'projects', 'ok.txt'), 'ok');
    const outside = join(process.env.WORKSPACE_ROOT!, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, join(root, 'projects', 'link.txt'));
    const attachments = service();
    await assert.rejects(
      () => attachments.prepare(auth, 'thread-unsafe', 'msg-dir', [{ source: 'personal', path: 'projects/empty-dir' }]),
      FilePathError,
    );
    await assert.rejects(
      () => attachments.prepare(auth, 'thread-unsafe', 'msg-dot', [{ source: 'personal', path: '../outside.txt' }]),
      FilePathError,
    );
    await assert.rejects(
      () => attachments.prepare(auth, 'thread-unsafe', 'msg-link', [{ source: 'personal', path: 'projects/link.txt' }]),
      FilePathError,
    );
    const items = Array.from({ length: 11 }, (_, index) => {
      const path = `projects/file-${index}.txt`;
      return { source: 'personal' as const, path };
    });
    for (const item of items) {
      await mkdir(join(root, 'projects'), { recursive: true });
      await writeFile(join(root, item.path), item.path);
    }
    await assert.rejects(
      () => attachments.prepare(auth, 'thread-unsafe', 'msg-ten', items),
      (error: unknown) => error instanceof FileServiceError && error.status === 400,
    );
  });
});

test('stale unsent refs older than 24h are cleaned only after Mastra confirms no message', async () => {
  await withMemory(async () => {
    const files = new WorkspaceFileService();
    const auth = authContextFromUser(user(USER_ID));
    const uploaded = await files.upload(auth, new File(['keep'], 'keep.txt'));
    const persisted = new Set<string>(['kept-msg']);
    const attachments = new AttachmentService(lookup(), {
      messageLookup: {
        async hasPersistedClientMessage({ clientMessageId }) {
          return persisted.has(clientMessageId);
        },
      },
    });
    await attachments.prepare(auth, 'thread-cleanup', 'kept-msg', [{ source: 'personal', path: uploaded.path }]);
    await attachments.prepare(auth, 'thread-cleanup', 'orphan-msg', [{ source: 'personal', path: uploaded.path }]);
    const now = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await attachments.cleanupStalePending({ now });
    const listed = await attachments.listForThread(auth, 'thread-cleanup');
    assert.equal(listed.some(item => item.clientMessageId === 'kept-msg'), true);
    assert.equal(listed.some(item => item.clientMessageId === 'orphan-msg'), false);
    const host = join(process.env.WORKSPACE_ROOT!, 'users', USER_ID, 'workspace', uploaded.path);
    assert.equal(await readFile(host, 'utf8'), 'keep');
  });
});

test('attachment HTTP routes prepare, list, isolate users and reject unsafe items', async () => {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT']);
  delete process.env.DATABASE_URL;
  try {
    const { app } = await appWithWorkspace();
    const headers = { authorization: 'Bearer user', 'content-type': 'application/json' };
    const body = JSON.stringify({
      threadId: THREAD_A,
      clientMessageId: 'composer-1',
      items: [{ source: 'personal', path: 'projects/note.txt' }],
    });
    const prepared = await app.request('/current-workspace/attachments', { method: 'POST', headers, body });
    assert.equal(prepared.status, 200);
    const preparedBody = await prepared.json() as {
      attachments: Array<{ attachmentId: string; path: string; status: string; name: string }>;
    };
    assert.equal(preparedBody.attachments.length, 1);
    assert.equal(preparedBody.attachments[0]!.path, 'projects/note.txt');
    assert.equal(preparedBody.attachments[0]!.status, 'available');

    const listed = await app.request(`/current-workspace/attachments?threadId=${THREAD_A}`, {
      headers: { authorization: 'Bearer user' },
    });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { attachments: Array<{ attachmentId: string }> };
    assert.equal(listedBody.attachments.length, 1);

    assert.equal((await app.request('/current-workspace/attachments', {
      method: 'POST',
      headers: { authorization: 'Bearer other', 'content-type': 'application/json' },
      body,
    })).status, 403);
    assert.equal((await app.request(`/current-workspace/attachments?threadId=${THREAD_A}`, {
      headers: { authorization: 'Bearer other' },
    })).status, 403);
    assert.equal((await app.request('/current-workspace/attachments', { method: 'POST', body })).status, 401);
    assert.equal((await app.request('/current-workspace/attachments', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        threadId: THREAD_A,
        clientMessageId: 'composer-agent',
        items: [{ source: 'agent', path: 'output/agent.txt' }],
      }),
    })).status, 403);
    assert.equal((await app.request('/current-workspace/attachments', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        threadId: THREAD_A,
        clientMessageId: 'composer-bad',
        items: [{ source: 'personal', path: '../secret.txt' }],
      }),
    })).status, 400);
  } finally {
    restoreEnv(env);
  }
});

test('postgres stores scoped attachment refs without copying workspace files',
  { skip: !DATABASE_URL }, async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'attach-db-'));
  const { getPool } = await import('../src/mastra/auth/db');
  const { createUser } = await import('../src/mastra/auth/service');
  const created = await createUser({
    email: `attach-${randomUUID()}@example.test`,
    displayName: 'Attach',
    password: 'correct horse battery staple',
    role: 'user',
  });
  const threadId = `thread-${created.id.slice(0, 8)}`;
  const dbLookup = {
    getThreadById: async ({ threadId: id }: { threadId: string }) =>
      id === threadId ? { id: threadId, resourceId: created.id } : null,
  };
  try {
    const auth = authContextFromUser({
      id: created.id, email: created.email, displayName: created.displayName, roles: created.roles,
    });
    const files = new WorkspaceFileService();
    const uploaded = await files.upload(auth, new File(['db-bytes'], 'db.txt'));
    const attachments = new AttachmentService(dbLookup);
    const prepared = await attachments.prepare(auth, threadId, 'db-msg', [
      { source: 'personal', path: uploaded.path },
    ]);
    const row = await getPool().query(
      'SELECT owner_id, thread_id, path, size FROM app_attachment_refs WHERE id = $1',
      [prepared[0]!.attachmentId],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].owner_id, created.id);
    assert.equal(row.rows[0].path, uploaded.path);
    assert.ok(!String(row.rows[0]).includes('db-bytes'));
    const host = join(process.env.WORKSPACE_ROOT, 'users', created.id, 'workspace', uploaded.path);
    assert.equal(await readFile(host, 'utf8'), 'db-bytes');
  } finally {
    await getPool().query('DELETE FROM app_users WHERE id = $1', [created.id]);
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
    if (DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = DATABASE_URL;
  }
});
