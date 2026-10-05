import { join, resolve, sep } from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function workspaceBase(): string {
  const configured = process.env.WORKSPACE_ROOT?.trim() || '/data/mastra';
  if (configured.includes('\0')) throw new Error('WORKSPACE_ROOT is invalid');
  return resolve(configured);
}

export function workspaceRoot(userId: string): string {
  assertUuid(userId);
  return join(workspaceBase(), 'users', userId, 'workspace');
}

export function threadRoot(userId: string, threadId: string): string {
  assertThreadId(threadId);
  return join(workspaceRoot(userId), 'threads', threadId);
}

export function containerThreadPath(threadId: string): string {
  assertThreadId(threadId);
  return `/workspace/threads/${threadId}`;
}

export function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error('User id is not a UUID');
  }
}

export function assertThreadId(threadId: string): void {
  if (!THREAD_ID_PATTERN.test(threadId) || threadId === '.' || threadId === '..' || threadId.includes(sep)) {
    throw new Error('Thread id is not a safe path segment');
  }
}

export function assertContained(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    throw new Error('Path escapes the workspace root');
  }
  return resolved;
}
