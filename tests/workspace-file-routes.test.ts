import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import type { ApiRoute } from '@mastra/core/server';
import * as fileRoutes from '../src/mastra/files/routes';
import { readWorkspaceVersion } from '../src/mastra/files/workspace-editor';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

async function appWithWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-files-'));
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'user-workspaces-'));
  process.env.USER_FILES_ENABLED = 'true';
  await mkdir(join(root, 'output'));
  await writeFile(join(root, 'output', 'result.md'), '# Result');
  await mkdir(join(process.env.WORKSPACE_ROOT, 'users', USER_ID, 'workspace', 'projects'), { recursive: true });
  await writeFile(join(process.env.WORKSPACE_ROOT, 'users', USER_ID, 'workspace', 'projects', 'own.md'), '# Own');
  const workspace = new Workspace({ id: 'agent-workspace', name: 'Agent workspace',
    filesystem: new LocalFilesystem({ basePath: root, contained: true }) });
  const app = new Hono();
  const createRoutes = (fileRoutes as unknown as { createCurrentWorkspaceFileRoutes: () => ApiRoute[] })
    .createCurrentWorkspaceFileRoutes;
  for (const route of createRoutes()) {
    if (!('handler' in route) || !route.handler) throw new Error(`Missing handler: ${route.path}`);
    const handler = route.handler;
    app.on(route.method, route.path, async (c, next) => {
      const requestContext = new RequestContext();
      const token = c.req.header('authorization')?.replace(/^Bearer /i, '');
      if (token === 'admin') requestContext.set('mastra__user',
        { id: ADMIN_ID, email: 'admin@example.test', displayName: 'Admin', roles: ['admin'] });
      if (token === 'user') requestContext.set('mastra__user',
        { id: USER_ID, email: 'user@example.test', displayName: 'User', roles: ['user'] });
      c.set('requestContext', requestContext);
      c.set('mastra', { getAgent: () => ({ getWorkspace: async () => workspace }) });
      return handler(c, next);
    });
  }
  return app;
}

test('an admin can list and download the legacy Agent workspace separately', async () => {
  const app = await appWithWorkspace();
  const headers = { authorization: 'Bearer admin' };
  const listed = await app.request('/current-workspace/files?source=agent', { headers });
  assert.equal(listed.status, 200);
  const body = await listed.json() as { workspaceId: string; files: Array<{ path: string }> };
  assert.equal(body.workspaceId, 'agent-workspace');
  assert.ok(body.files.some(file => file.path === 'output/result.md'));
  const downloaded = await app.request('/current-workspace/files/output/result.md?source=agent', { headers });
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), '# Result');
  assert.match(downloaded.headers.get('content-disposition') ?? '', /result\.md/);
});

test('a user sees every directory and file in their own workspace, not another account or the Agent workspace', async () => {
  const app = await appWithWorkspace();
  const userHeaders = { authorization: 'Bearer user' };
  const listed = await app.request('/current-workspace/files', { headers: userHeaders });
  assert.equal(listed.status, 200);
  const body = await listed.json() as { workspaceId: string; files: Array<{ path: string }> };
  assert.equal(body.workspaceId, `ws_${USER_ID}`);
  assert.ok(body.files.some(file => file.path === 'projects'));
  assert.ok(body.files.some(file => file.path === 'projects/own.md'));
  assert.ok(!body.files.some(file => file.path === 'output/result.md'));
  const downloaded = await app.request('/current-workspace/files/projects/own.md', { headers: userHeaders });
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), '# Own');
  const admin = await app.request('/current-workspace/files/projects/own.md',
    { headers: { authorization: 'Bearer admin' } });
  assert.notEqual(admin.status, 200);
});

test('workspace listing includes directories and files deeper than twenty levels', async () => {
  const app = await appWithWorkspace();
  const nested = Array.from({ length: 22 }, (_, index) => `level-${index}`).join('/');
  const root = join(process.env.WORKSPACE_ROOT!, 'users', USER_ID, 'workspace');
  await mkdir(join(root, nested), { recursive: true });
  await writeFile(join(root, nested, 'deep.md'), '# Deep');
  const response = await app.request('/current-workspace/files',
    { headers: { authorization: 'Bearer user' } });
  assert.equal(response.status, 200);
  const body = await response.json() as { files: Array<{ path: string }> };
  assert.ok(body.files.some(file => file.path === `${nested}/deep.md`));
});

test('workspace browsing rejects anonymous, non-admin and traversal requests', async () => {
  const app = await appWithWorkspace();
  assert.equal((await app.request('/current-workspace/files')).status, 401);
  assert.equal((await app.request('/current-workspace/files?source=agent',
    { headers: { authorization: 'Bearer user' } })).status, 403);
  assert.equal((await app.request('/current-workspace/files/%2e%2e%2fsecret.txt?source=agent',
    { headers: { authorization: 'Bearer admin' } })).status, 400);
  assert.equal((await app.request('/current-workspace/files/missing.md',
    { headers: { authorization: 'Bearer user' } })).status, 404);
});

test('conditional save edits only the owned workspace and returns a new ETag', async () => {
  const app = await appWithWorkspace();
  const headers = { authorization: 'Bearer user' };
  const path = '/current-workspace/files/projects/own.md';
  const original = await app.request(path, { headers });
  const etag = original.headers.get('etag');
  assert.ok(etag);
  const saved = await app.request(path, { method: 'PUT', headers: {
    ...headers, 'content-type': 'text/plain; charset=utf-8', 'if-match': etag,
  }, body: '# Changed' });
  assert.equal(saved.status, 200);
  assert.notEqual(saved.headers.get('etag'), etag);
  assert.equal(await (await app.request(path, { headers })).text(), '# Changed');
  const stale = await app.request(path, { method: 'PUT', headers: {
    ...headers, 'content-type': 'text/plain; charset=utf-8', 'if-match': etag,
  }, body: '# Stale' });
  assert.equal(stale.status, 412);
  assert.equal(await (await app.request(path, { headers })).text(), '# Changed');
});

test('reads and saves a Unicode filename and UTF-8 content', async () => {
  const app = await appWithWorkspace();
  const root = join(process.env.WORKSPACE_ROOT!, 'users', USER_ID, 'workspace', 'projects');
  await writeFile(join(root, '中文.md'), '原文 😀');
  const path = '/current-workspace/files/projects/%E4%B8%AD%E6%96%87.md';
  const headers = { authorization: 'Bearer user' };
  const original = await app.request(path, { headers });
  assert.equal(original.status, 200);
  assert.equal(await original.text(), '原文 😀');
  assert.match(original.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/);
  const etag = original.headers.get('etag');
  assert.ok(etag);
  const saved = await app.request(path, { method: 'PUT', headers: {
    ...headers, 'content-type': 'text/plain; charset=utf-8', 'if-match': etag,
  }, body: '修改后 😀' });
  assert.equal(saved.status, 200);
  assert.equal(await readFile(join(root, '中文.md'), 'utf8'), '修改后 😀');
});

test('personal workspace upload uses unique safe paths and returns usage on list', async () => {
  const app = await appWithWorkspace();
  const headers = { authorization: 'Bearer user' };
  const form = new FormData();
  form.set('file', new File(['hello'], '说明 文档 #1%.txt', { type: 'text/plain' }));
  const uploaded = await app.request('/current-workspace/upload', { method: 'POST', headers, body: form });
  assert.equal(uploaded.status, 201);
  const entry = await uploaded.json() as {
    source: string; path: string; name: string; size: number; mimeType: string; etag: string;
  };
  assert.equal(entry.source, 'personal');
  assert.equal(entry.name, '说明 文档 #1%.txt');
  assert.match(entry.path, /^uploads\/[0-9a-f-]{36}\/说明 文档 #1%\.txt$/i);
  assert.equal(entry.size, 5);
  const again = new FormData();
  again.set('file', new File(['hello'], '说明 文档 #1%.txt', { type: 'text/plain' }));
  const second = await app.request('/current-workspace/upload', { method: 'POST', headers, body: again });
  assert.equal(second.status, 201);
  const secondEntry = await second.json() as { path: string };
  assert.notEqual(secondEntry.path, entry.path);

  const nested = join(process.env.WORKSPACE_ROOT!, 'users', USER_ID, 'workspace', 'projects', 'nested');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'child.txt'), 'abcdefg');
  const listed = await app.request('/current-workspace/files', { headers });
  assert.equal(listed.status, 200);
  const body = await listed.json() as {
    files: Array<{ path: string; type: string; size: number }>;
    usage?: { usedBytes: number; quotaBytes: number; fileCount: number };
  };
  const projects = body.files.find(file => file.path === 'projects');
  const nestedDir = body.files.find(file => file.path === 'projects/nested');
  assert.equal(projects?.type, 'directory');
  assert.ok((projects?.size ?? 0) >= 7);
  assert.equal(nestedDir?.size, 7);
  assert.ok(body.usage);
  assert.ok(body.usage.usedBytes >= 5 + 7);
  assert.equal(body.usage.quotaBytes, 500 * 1024 * 1024);
});

test('agent workspace listing omits personal usage and stays admin-only', async () => {
  const app = await appWithWorkspace();
  const listed = await app.request('/current-workspace/files?source=agent', {
    headers: { authorization: 'Bearer admin' },
  });
  assert.equal(listed.status, 200);
  const body = await listed.json() as { usage?: unknown; files: Array<{ path: string; size: number; type: string }> };
  assert.equal(body.usage, undefined);
  const output = body.files.find(file => file.path === 'output');
  assert.equal(output?.type, 'directory');
  assert.ok((output?.size ?? 0) > 0);
  assert.equal((await app.request('/current-workspace/upload?source=agent', {
    method: 'POST',
    headers: { authorization: 'Bearer admin' },
    body: (() => { const form = new FormData(); form.set('file', new File(['x'], 'x.txt')); return form; })(),
  })).status, 403);
});

test('workspace upload rejects anonymous, other users, oversized files, quota and symlinks', async () => {
  const previousMax = process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
  const previousQuota = process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
  const previousDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const app = await appWithWorkspace();
    const form = new FormData();
    form.set('file', new File(['hello'], 'note.txt'));
    assert.equal((await app.request('/current-workspace/upload', { method: 'POST', body: form })).status, 401);

    const userHeaders = { authorization: 'Bearer user' };
    const uploaded = await app.request('/current-workspace/upload', {
      method: 'POST', headers: userHeaders, body: form,
    });
    assert.equal(uploaded.status, 201);
    const other = await app.request('/current-workspace/files', { headers: { authorization: 'Bearer admin' } });
    assert.equal(other.status, 200);
    const otherBody = await other.json() as { files: Array<{ path: string }> };
    assert.ok(!otherBody.files.some(file => file.path.includes('note.txt')));

    process.env.WORKSPACE_MAX_FILE_SIZE_BYTES = '8';
    const huge = new FormData();
    huge.set('file', new File(['0123456789'], 'huge.bin'));
    const tooLarge = await app.request('/current-workspace/upload', {
      method: 'POST', headers: userHeaders, body: huge,
    });
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json() as { code?: string }).code, 'FILE_TOO_LARGE');
    delete process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;

    const outside = join(process.env.WORKSPACE_ROOT!, 'outside.txt');
    await writeFile(outside, 'outside');
    const root = join(process.env.WORKSPACE_ROOT!, 'users', USER_ID, 'workspace');
    await symlink(outside, join(root, 'link.txt'));
    const listed = await app.request('/current-workspace/files', { headers: userHeaders });
    const listedBody = await listed.json() as { files: Array<{ path: string }>; usage?: { usedBytes: number } };
    assert.ok(!listedBody.files.some(file => file.path === 'link.txt'));
  } finally {
    if (previousMax === undefined) delete process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
    else process.env.WORKSPACE_MAX_FILE_SIZE_BYTES = previousMax;
    if (previousQuota === undefined) delete process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
    else process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = previousQuota;
    if (previousDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDb;
  }
});

test('workspace upload maps quota failures to WORKSPACE_QUOTA_EXCEEDED', async () => {
  const previous = {
    quota: process.env.WORKSPACE_DEFAULT_QUOTA_BYTES,
    database: process.env.DATABASE_URL,
    enabled: process.env.USER_FILES_ENABLED,
  };
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '4';
  process.env.USER_FILES_ENABLED = 'true';
  try {
    const quotaUser = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'user-workspaces-'));
    await mkdir(join(process.env.WORKSPACE_ROOT, 'users', quotaUser, 'workspace', 'uploads'), { recursive: true });
    const app = new Hono();
    const createRoutes = (fileRoutes as unknown as { createCurrentWorkspaceFileRoutes: () => ApiRoute[] })
      .createCurrentWorkspaceFileRoutes;
    for (const route of createRoutes()) {
      if (!('handler' in route) || !route.handler) throw new Error(`Missing handler: ${route.path}`);
      const handler = route.handler;
      app.on(route.method, route.path, async (c, next) => {
        const requestContext = new RequestContext();
        requestContext.set('mastra__user',
          { id: quotaUser, email: 'q@example.test', displayName: 'Q', roles: ['user'] });
        c.set('requestContext', requestContext);
        c.set('mastra', { getAgent: () => ({ getWorkspace: async () => undefined }) });
        return handler(c, next);
      });
    }
    const quotaForm = new FormData();
    quotaForm.set('file', new File(['12345'], 'over.txt'));
    const quota = await app.request('/current-workspace/upload', {
      method: 'POST',
      headers: { authorization: 'Bearer user' },
      body: quotaForm,
    });
    assert.equal(quota.status, 413);
    assert.equal((await quota.json() as { code?: string }).code, 'WORKSPACE_QUOTA_EXCEEDED');
  } finally {
    if (previous.quota === undefined) delete process.env.WORKSPACE_DEFAULT_QUOTA_BYTES;
    else process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = previous.quota;
    if (previous.database === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.database;
    if (previous.enabled === undefined) delete process.env.USER_FILES_ENABLED;
    else process.env.USER_FILES_ENABLED = previous.enabled;
  }
});

test('USER_FILES_ENABLED=false rejects workspace upload/delete/prepare but GET list stays open', async () => {
  const previous = process.env.USER_FILES_ENABLED;
  try {
    const app = await appWithWorkspace();
    process.env.USER_FILES_ENABLED = 'false';
    const headers = { authorization: 'Bearer user' };
    const form = new FormData();
    form.set('file', new File(['x'], 'gate.txt'));
    assert.equal((await app.request('/current-workspace/upload', {
      method: 'POST', headers, body: form,
    })).status, 404);
    assert.equal((await app.request('/current-workspace/files/batch-delete', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['projects/own.md'] }),
    })).status, 404);
    assert.equal((await app.request('/current-workspace/attachments', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: 't', clientMessageId: 'm', items: [{ source: 'personal', path: 'projects/own.md' }],
      }),
    })).status, 404);
    const listed = await app.request('/current-workspace/files', { headers });
    assert.equal(listed.status, 200);
  } finally {
    if (previous === undefined) delete process.env.USER_FILES_ENABLED;
    else process.env.USER_FILES_ENABLED = previous;
  }
});

test('save enforces Agent admin access and blocks traversal and symlinks', async () => {
  const app = await appWithWorkspace();
  const headers = { 'content-type': 'text/plain; charset=utf-8',
    'if-match': readWorkspaceVersion(Buffer.from('outside')) };
  assert.equal((await app.request('/current-workspace/files/output/result.md?source=agent',
    { method: 'PUT', headers: { ...headers, authorization: 'Bearer user' }, body: 'x' })).status, 403);
  assert.equal((await app.request('/current-workspace/files/projects/own.md',
    { method: 'PUT', headers, body: 'x' })).status, 401);
  assert.equal((await app.request('/current-workspace/files/%2e%2e%2foutside',
    { method: 'PUT', headers: { ...headers, authorization: 'Bearer user' }, body: 'x' })).status, 400);
  const outside = join(process.env.WORKSPACE_ROOT!, 'outside.txt');
  await writeFile(outside, 'outside');
  const root = join(process.env.WORKSPACE_ROOT!, 'users', USER_ID, 'workspace');
  await symlink(outside, join(root, 'link.txt'));
  const linked = await app.request('/current-workspace/files/link.txt', { method: 'PUT',
    headers: { ...headers, authorization: 'Bearer user' }, body: 'x' });
  assert.notEqual(linked.status, 200);
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});
