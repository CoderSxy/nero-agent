import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import type { ApiRoute } from '@mastra/core/server';
import * as fileRoutes from '../src/mastra/files/routes';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

async function appWithWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-files-'));
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'user-workspaces-'));
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
