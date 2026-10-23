import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { WorkspaceFilesystem } from '@mastra/core/workspace';
import { getPool } from '../auth/db';
import { withManualWorkspaceMutation } from './artifacts/collector';
import type { WorkspaceMutationToken } from './artifacts/mutation-coordinator';

import { workspaceQuota, QuotaExceededError } from '../workspace/quota';
import { assertHostWritable, DiskProtectionError } from '../workspace/disk-protection';

type MutationOptions = { mutationToken?: WorkspaceMutationToken; signal?: AbortSignal };

const MAX_EDIT_BYTES = 10 * 1024 * 1024;
const MAX_REPLACE_TEXT_BYTES = 64 * 1024;
const pending = new Map<string, Promise<unknown>>();

export class WorkspaceEditError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 412 | 413, message: string, readonly code?: string) {
    super(message);
    this.name = 'WorkspaceEditError';
  }
}

export function readWorkspaceVersion(data: Uint8Array): string {
  return `"${createHash('sha256').update(data).digest('hex')}"`;
}

export function isWorkspaceText(data: Uint8Array): boolean {
  if (data.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(data); return true; }
  catch { return false; }
}

function assertValidEtag(expectedEtag: string): void {
  if (!/^"[a-f0-9]{64}"$/.test(expectedEtag)) {
    throw new WorkspaceEditError(400, '缺少有效的文件版本');
  }
}

async function pathLockKey(filesystem: WorkspaceFilesystem, path: string, userId?: string): Promise<string> {
  // Unify Web (personal-root + threads/<tid>/…) and Agent (thread-root + …) on the same physical file.
  const identity = filesystem.basePath
    ? await hostFilePath(filesystem, path)
    : path;
  if (userId) return `${userId}:${identity}`;
  return `${filesystem.basePath ?? filesystem.id}:${identity}`;
}

function countOverlappingOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    count += 1;
    from = index + 1;
  }
  return count;
}

async function assertExistingRegularFile(filesystem: WorkspaceFilesystem, path: string) {
  if (!filesystem.basePath) return;
  const root = await realpath(filesystem.basePath);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith('..' + sep) || rel === '..' || rel.startsWith(sep))
    throw new WorkspaceEditError(400, '文件路径无效');
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceEditError(404, '文件不存在');
      throw error;
    }
    if (info.isSymbolicLink()) throw new WorkspaceEditError(400, '不允许编辑符号链接');
    if (current === target && !info.isFile()) throw new WorkspaceEditError(409, '只能编辑普通文件');
  }
}

async function hostFilePath(filesystem: WorkspaceFilesystem, path: string): Promise<string> {
  if (!filesystem.basePath) throw new WorkspaceEditError(400, '文件路径无效');
  const root = await realpath(filesystem.basePath);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith('..' + sep) || rel === '..' || rel.startsWith(sep)) {
    throw new WorkspaceEditError(400, '文件路径无效');
  }
  return target;
}

function mapNoFollowOpenError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ELOOP') throw new WorkspaceEditError(400, '不允许编辑符号链接');
  if (code === 'ENOENT') throw new WorkspaceEditError(404, '文件不存在');
  if (code === 'EINVAL') throw new WorkspaceEditError(409, '只能编辑普通文件');
  throw error;
}

/** Read file bytes without following symlinks (O_NOFOLLOW + fstat regular-file check). */
async function readHostFileNoFollow(hostPath: string): Promise<Buffer> {
  try {
    const handle = await open(hostPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new WorkspaceEditError(409, '只能编辑普通文件');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof WorkspaceEditError) throw error;
    mapNoFollowOpenError(error);
  }
}

async function atomicWrite(hostPath: string, next: Buffer): Promise<void> {
  const dir = dirname(hostPath);
  const tmp = join(dir, `.${randomBytes(12).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, next);
    // Refuse to replace if the destination was swapped to a symlink after lstat.
    try {
      const dest = await open(hostPath, constants.O_WRONLY | constants.O_NOFOLLOW);
      try {
        const info = await dest.stat();
        if (!info.isFile()) throw new WorkspaceEditError(409, '只能编辑普通文件');
        await chmod(tmp, info.mode & 0o7777);
      } finally {
        await dest.close();
      }
    } catch (error) {
      if (error instanceof WorkspaceEditError) throw error;
      mapNoFollowOpenError(error);
    }
    await rename(tmp, hostPath);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

async function withPathLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    if (!process.env.DATABASE_URL) return operation();
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const result = await operation();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
  pending.set(key, run);
  try {
    return await run;
  } finally {
    if (pending.get(key) === run) pending.delete(key);
  }
}

async function mutateWorkspaceText(
  filesystem: WorkspaceFilesystem,
  path: string,
  expectedEtag: string,
  userId: string | undefined,
  transform: (currentText: string) => Buffer,
  options: MutationOptions = {},
): Promise<{ etag: string; size: number }> {
  assertValidEtag(expectedEtag);
  const key = await pathLockKey(filesystem, path, userId);

  const mutate = () => withPathLock(key, async () => {
    await assertExistingRegularFile(filesystem, path);
    let current: Uint8Array;
    try {
      if (filesystem.basePath) {
        // Prefer O_NOFOLLOW over LocalFilesystem.readFile, which may follow symlinks.
        current = await readHostFileNoFollow(await hostFilePath(filesystem, path));
      } else {
        const read = await filesystem.readFile(path);
        current = typeof read === 'string' ? Buffer.from(read, 'utf8') : read;
      }
    } catch (error) {
      if (error instanceof WorkspaceEditError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceEditError(404, '文件不存在');
      throw error;
    }
    if (current.length > MAX_EDIT_BYTES) {
      throw new WorkspaceEditError(413, '文件超过在线编辑上限', 'FILE_TOO_LARGE');
    }
    if (!isWorkspaceText(current)) throw new WorkspaceEditError(409, '该文件不支持文本编辑');
    if (readWorkspaceVersion(current) !== expectedEtag) {
      throw new WorkspaceEditError(412, '文件已被其他操作修改，请重新打开', 'STALE_VERSION');
    }

    const currentText = new TextDecoder('utf-8', { fatal: true }).decode(current);
    const next = transform(currentText);
    if (next.length > MAX_EDIT_BYTES) {
      throw new WorkspaceEditError(413, '文件超过在线编辑上限', 'FILE_TOO_LARGE');
    }

    const growth = Math.max(0, next.length - current.length);
    if (userId) {
      try {
        // Always check host disk, including equal-size / shrinking edits.
        await assertHostWritable(growth);
        if (growth) await workspaceQuota.reserve(userId, growth, 0);
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          throw new WorkspaceEditError(413, error.message, error.code);
        }
        if (error instanceof DiskProtectionError) {
          throw new WorkspaceEditError(409, error.message);
        }
        throw error;
      }
    }

    try {
      const hostPath = await hostFilePath(filesystem, path);
      await atomicWrite(hostPath, next);
    } catch (error) {
      if (userId && growth) await workspaceQuota.releaseReserve(userId, growth, 0);
      throw error;
    }

    if (userId && growth) await workspaceQuota.commit(userId, growth, 0);
    if (userId && next.length < current.length) {
      await workspaceQuota.release(userId, current.length - next.length, 0);
    }
    return { etag: readWorkspaceVersion(next), size: next.length };
  });
  return userId
    ? withManualWorkspaceMutation({ userId, roles: [] }, mutate, { token: options.mutationToken, signal: options.signal })
    : mutate();
}

export async function saveWorkspaceText(
  filesystem: WorkspaceFilesystem, path: string, text: string, expectedEtag: string, userId?: string,
  options: MutationOptions = {},
): Promise<string> {
  if (text.includes('\0')) throw new WorkspaceEditError(400, '文件包含无效文本');
  const next = Buffer.from(text, 'utf8');
  if (next.length > MAX_EDIT_BYTES) throw new WorkspaceEditError(413, '文件超过在线编辑上限', 'FILE_TOO_LARGE');
  if (next.toString('utf8') !== text) throw new WorkspaceEditError(400, '文件包含无效 UTF-8 文本');

  const result = await mutateWorkspaceText(filesystem, path, expectedEtag, userId, () => next, options);
  return result.etag;
}

export async function replaceWorkspaceText(
  filesystem: WorkspaceFilesystem,
  path: string,
  oldText: string,
  newText: string,
  expectedEtag: string,
  userId: string,
  options: MutationOptions = {},
): Promise<{ etag: string; size: number }> {
  if (!oldText) throw new WorkspaceEditError(400, '替换原文不能为空', 'NO_MATCH');
  if (oldText.includes('\0') || newText.includes('\0')) {
    throw new WorkspaceEditError(400, '文件包含无效文本');
  }
  const oldBytes = Buffer.byteLength(oldText, 'utf8');
  const newBytes = Buffer.byteLength(newText, 'utf8');
  if (oldBytes > MAX_REPLACE_TEXT_BYTES || newBytes > MAX_REPLACE_TEXT_BYTES) {
    throw new WorkspaceEditError(400, '替换文本超过 64 KiB 上限');
  }
  if (Buffer.from(oldText, 'utf8').toString('utf8') !== oldText
    || Buffer.from(newText, 'utf8').toString('utf8') !== newText) {
    throw new WorkspaceEditError(400, '文件包含无效 UTF-8 文本');
  }

  return mutateWorkspaceText(filesystem, path, expectedEtag, userId, currentText => {
    const matches = countOverlappingOccurrences(currentText, oldText);
    if (matches === 0) {
      throw new WorkspaceEditError(409, '未找到要替换的原文', 'NO_MATCH');
    }
    if (matches > 1) {
      throw new WorkspaceEditError(409, '原文出现多次，无法唯一替换', 'AMBIGUOUS_MATCH');
    }
    const index = currentText.indexOf(oldText);
    const nextText = currentText.slice(0, index) + newText + currentText.slice(index + oldText.length);
    return Buffer.from(nextText, 'utf8');
  }, options);
}
