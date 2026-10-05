import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { ensureUserWorkspace, workspaceRoot } from '../src/mastra/workspace/manager';
import { resolveUserFilesystem } from '../src/mastra/workspace/resolver';
import type { AuthContext } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const MASTRA_USER_KEY = 'mastra__user';

function auth(userId: string, roles: AuthUser['roles'] = ['admin']): AuthContext {
  return { userId, roles };
}

function user(userId: string, roles: AuthUser['roles'] = ['admin']): AuthUser {
  return { id: userId, email: `${userId}@example.test`, displayName: 'w', roles };
}

test('ensureUserWorkspace creates distinct roots and is idempotent', async () => {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'ws-iso-'));
  const first = await ensureUserWorkspace(auth(USER_A));
  const second = await ensureUserWorkspace(auth(USER_A));
  const other = await ensureUserWorkspace(auth(USER_B));
  assert.equal(first, second);
  assert.equal(first, workspaceRoot(USER_A));
  assert.notEqual(first, other);
  assert.equal(await realpath(first), await realpath(workspaceRoot(USER_A)));
});

test('ensureUserWorkspace refuses a parent directory replaced by a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-link-'));
  process.env.WORKSPACE_ROOT = root;
  const outside = await mkdtemp(join(tmpdir(), 'ws-out-'));
  const usersDir = join(root, 'users');
  await mkdir(usersDir, { recursive: true });
  await symlink(outside, join(usersDir, USER_A));
  await assert.rejects(() => ensureUserWorkspace(auth(USER_A)));
});

test('resolveUserFilesystem is contained to the authenticated user root', async () => {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'ws-fs-'));
  process.env.WORKSPACE_RESOLVER_ENABLED = 'true';
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_USER_KEY, user(USER_A));
  const filesystem = await resolveUserFilesystem({ requestContext });
  assert.equal(filesystem.contained, true);
  assert.equal(await realpath(filesystem.basePath), await realpath(workspaceRoot(USER_A)));
});
