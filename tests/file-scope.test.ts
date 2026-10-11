import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import {
  resolveFileToolRoot,
  resolveScopedPath,
  type FileToolScope,
} from '../src/mastra/files/file-scope';
import { ensureThreadDirectory, ensureUserWorkspace } from '../src/mastra/workspace/manager';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const THREAD_A = 'thread-a1';
const THREAD_B = 'thread-b2';
const UPLOAD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

function lookup() {
  return {
    getThreadById: async ({ threadId }: { threadId: string }) => {
      if (threadId === THREAD_A) return { id: threadId, resourceId: USER_A };
      if (threadId === THREAD_B) return { id: threadId, resourceId: USER_A };
      return null;
    },
  };
}

async function withRoot(run: (root: string) => Promise<void>) {
  const previous = process.env.WORKSPACE_ROOT;
  const root = await mkdtemp(join(tmpdir(), 'file-scope-'));
  process.env.WORKSPACE_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previous;
  }
}

test('resolveFileToolRoot returns owned thread and personal workspace roots', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const threadRoot = await resolveFileToolRoot(auth, THREAD_A, lookup(), 'thread');
    const workspaceRoot = await resolveFileToolRoot(auth, THREAD_A, lookup(), 'workspace');
    const expectedThread = (await ensureThreadDirectory(auth, THREAD_A, lookup())).hostPath;
    const expectedWorkspace = await ensureUserWorkspace(auth);
    assert.equal(threadRoot, expectedThread);
    assert.equal(workspaceRoot, expectedWorkspace);
    assert.ok(threadRoot.endsWith(join('threads', THREAD_A)));
    assert.ok(workspaceRoot.endsWith(join('users', USER_A, 'workspace')));
  });
});

test('resolveFileToolRoot accepts explicit thread and workspace scopes', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    for (const scope of ['thread', 'workspace'] as FileToolScope[]) {
      const root = await resolveFileToolRoot(auth, THREAD_A, lookup(), scope);
      assert.equal(typeof root, 'string');
      assert.ok(root.length > 0);
    }
  });
});

test('resolveScopedPath resolves uploads under the personal workspace root', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const root = await resolveFileToolRoot(auth, THREAD_A, lookup(), 'workspace');
    const relative = `uploads/${UPLOAD_ID}/x.txt`;
    const hostFile = join(root, 'uploads', UPLOAD_ID, 'x.txt');
    await mkdir(join(root, 'uploads', UPLOAD_ID), { recursive: true });
    await writeFile(hostFile, 'hello');
    const resolved = await resolveScopedPath(root, relative, 'workspace', THREAD_A);
    assert.equal(resolved, hostFile);
  });
});

test('resolveScopedPath preserves whitespace in file names', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const root = await resolveFileToolRoot(auth, THREAD_A, lookup(), 'thread');
    await writeFile(join(root, ' a.txt '), 'spaced');
    await writeFile(join(root, 'a.txt'), 'plain');
    assert.equal(await resolveScopedPath(root, ' a.txt ', 'thread', THREAD_A), join(root, ' a.txt '));
  });
});

test('resolveFileToolRoot rejects cross-user spoofing for thread and workspace scopes', async () => {
  await withRoot(async () => {
    const spoof = authContextFromUser(user(USER_B));
    await assert.rejects(
      () => resolveFileToolRoot(spoof, THREAD_A, lookup(), 'thread'),
      /denied|belong|Access/i,
    );
    await assert.rejects(
      () => resolveFileToolRoot(spoof, THREAD_A, lookup(), 'workspace'),
      /denied|belong|Access/i,
    );
  });
});

test('resolveScopedPath rejects foreign threads subtrees in workspace scope', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const root = await resolveFileToolRoot(auth, THREAD_A, lookup(), 'workspace');
    await mkdir(join(root, 'threads', THREAD_B, 'reports'), { recursive: true });
    await writeFile(join(root, 'threads', THREAD_B, 'reports', 'secret.txt'), 'nope');
    await assert.rejects(
      () => resolveScopedPath(root, `threads/${THREAD_B}/reports/secret.txt`, 'workspace', THREAD_A),
    );
    const allowed = `threads/${THREAD_A}/note.txt`;
    await mkdir(join(root, 'threads', THREAD_A), { recursive: true });
    await writeFile(join(root, 'threads', THREAD_A, 'note.txt'), 'ok');
    const resolved = await resolveScopedPath(root, allowed, 'workspace', THREAD_A);
    assert.equal(resolved, join(root, 'threads', THREAD_A, 'note.txt'));
  });
});

test('resolveScopedPath rejects absolute, parent, and backslash paths', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const root = await resolveFileToolRoot(auth, THREAD_A, lookup(), 'thread');
    for (const bad of ['/etc/passwd', '../escape.txt', 'a\\b.txt', 'foo/../bar.txt']) {
      await assert.rejects(() => resolveScopedPath(root, bad, 'thread', THREAD_A));
    }
  });
});

test('resolveScopedPath rejects a symlinked parent segment', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const root = await resolveFileToolRoot(auth, THREAD_A, lookup(), 'thread');
    const outside = await mkdtemp(join(tmpdir(), 'file-scope-outside-'));
    await writeFile(join(outside, 'leak.txt'), 'secret');
    await symlink(outside, join(root, 'linked'));
    await assert.rejects(() => resolveScopedPath(root, 'linked/leak.txt', 'thread', THREAD_A));
  });
});

test('empty base path is allowed only when allowRoot is true', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const root = await resolveFileToolRoot(auth, THREAD_A, lookup(), 'thread');
    await assert.rejects(() => resolveScopedPath(root, '', 'thread', THREAD_A));
    await assert.rejects(() => resolveScopedPath(root, '', 'thread', THREAD_A, { allowRoot: false }));
    const resolved = await resolveScopedPath(root, '', 'thread', THREAD_A, { allowRoot: true });
    assert.equal(resolved, root);
  });
});
