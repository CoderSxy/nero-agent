import { FilePathError, relativeFilePath } from '../policy';

export type ArtifactPathScope = 'thread' | 'workspace';

/**
 * Normalize a tool-relative path into a personal-workspace POSIX relative path.
 * Thread-scoped writes become `threads/<threadId>/...`.
 */
export function normalizeArtifactPath(input: {
  scope: ArtifactPathScope;
  threadId: string;
  path: string;
}): string {
  const threadId = input.threadId.trim();
  if (!threadId || threadId.includes('/') || threadId.includes('\\') || threadId.includes('\0')) {
    throw new FilePathError('会话标识无效');
  }
  const rel = relativeFilePath(input.path);
  if (input.scope === 'thread') {
    return `threads/${threadId}/${rel}`;
  }
  // Workspace scope already uses workspace-relative paths.
  if (rel.startsWith('threads/')) {
    const segments = rel.split('/');
    if (segments[1] && segments[1] !== threadId) {
      throw new FilePathError('不允许访问其他会话目录');
    }
  }
  return rel;
}

/** True when path is a safe personal-workspace relative artifact path. */
export function isArtifactPath(path: string): boolean {
  try {
    relativeFilePath(path);
    return true;
  } catch {
    return false;
  }
}
