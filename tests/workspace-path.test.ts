import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadRoot, workspaceRoot } from '../src/mastra/workspace/path';

const USER_A = '73ff1799-b0e1-4bce-92d0-579061494064';
const USER_B = 'a157a4c1-413f-4d1c-83f1-bbf104573101';
const THREAD = 'thread-ok_1';

test('workspaceRoot and threadRoot keep users and threads in distinct directories', () => {
  process.env.WORKSPACE_ROOT = '/data/mastra';
  const a = workspaceRoot(USER_A);
  const b = workspaceRoot(USER_B);
  assert.equal(a, `/data/mastra/users/${USER_A}/workspace`);
  assert.equal(b, `/data/mastra/users/${USER_B}/workspace`);
  assert.notEqual(a, b);
  assert.equal(threadRoot(USER_A, THREAD), `/data/mastra/users/${USER_A}/workspace/threads/${THREAD}`);
});

test('path helpers reject traversal, absolute paths, dots, slashes and non-UUID users', () => {
  process.env.WORKSPACE_ROOT = '/data/mastra';
  assert.throws(() => workspaceRoot('../evil'));
  assert.throws(() => workspaceRoot('/etc/passwd'));
  assert.throws(() => workspaceRoot('not-a-uuid'));
  assert.throws(() => threadRoot(USER_A, '../x'));
  assert.throws(() => threadRoot(USER_A, '/etc'));
  assert.throws(() => threadRoot(USER_A, 'a/b'));
  assert.throws(() => threadRoot(USER_A, '.'));
  assert.throws(() => threadRoot(USER_A, '..'));
  assert.throws(() => threadRoot(USER_A, 'bad.thread'));
});
