import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { AuthContext } from '../auth/auth-context';
import { assertThreadOwned, type ThreadLookup } from '../auth/thread-guard';
import { ensureThreadDirectory, ensureUserWorkspace } from '../workspace/manager';
import { assertContained } from '../workspace/path';
import { FilePathError, relativeFilePath } from './policy';

export type FileToolScope = 'thread' | 'workspace';

export async function resolveFileToolRoot(
  auth: AuthContext,
  threadId: string,
  lookup: ThreadLookup,
  scope: FileToolScope,
): Promise<string> {
  await assertThreadOwned(auth, threadId, lookup);
  if (scope === 'thread') {
    const { hostPath } = await ensureThreadDirectory(auth, threadId, lookup);
    return hostPath;
  }
  return ensureUserWorkspace(auth);
}

export async function resolveScopedPath(
  root: string,
  relativePath: string,
  scope: FileToolScope,
  threadId: string,
  options: { allowRoot?: boolean } = {},
): Promise<string> {
  const allowRoot = options.allowRoot === true;
  const realRoot = await realpath(root);

  if (relativePath === '') {
    if (!allowRoot) throw new FilePathError();
    return root;
  }

  const rel = relativeFilePath(relativePath);
  assertAllowedThreadSubtree(rel, scope, threadId);

  const hostPath = join(root, ...rel.split('/'));
  const checkPath = join(realRoot, ...rel.split('/'));
  assertContained(realRoot, checkPath);
  await assertNoSymlinkSegments(realRoot, checkPath);
  return hostPath;
}

function assertAllowedThreadSubtree(rel: string, scope: FileToolScope, threadId: string): void {
  if (scope !== 'workspace') return;
  const segments = rel.split('/');
  if (segments[0] !== 'threads') return;
  if (segments.length < 2 || segments[1] !== threadId) {
    throw new FilePathError('不允许访问其他会话目录');
  }
}

async function assertNoSymlinkSegments(root: string, hostPath: string): Promise<void> {
  const rel = hostPath.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of rel) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FilePathError('文件不存在');
      }
      throw error;
    }
    if (info.isSymbolicLink()) throw new FilePathError('不允许通过符号链接访问');
    const real = await realpath(current);
    assertContained(root, real);
  }
}
