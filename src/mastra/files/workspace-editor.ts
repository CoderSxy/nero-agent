import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { WorkspaceFilesystem } from '@mastra/core/workspace';
import { workspaceQuota, QuotaExceededError } from '../workspace/quota';
import { assertHostWritable, DiskProtectionError } from '../workspace/disk-protection';

const MAX_EDIT_BYTES = 10 * 1024 * 1024;
const pending = new Map<string, Promise<unknown>>();

export class WorkspaceEditError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 412 | 413, message: string) {
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

export async function saveWorkspaceText(
  filesystem: WorkspaceFilesystem, path: string, text: string, expectedEtag: string, userId?: string,
): Promise<string> {
  if (!/^"[a-f0-9]{64}"$/.test(expectedEtag)) throw new WorkspaceEditError(400, '缺少有效的文件版本');
  if (text.includes('\0')) throw new WorkspaceEditError(400, '文件包含无效文本');
  const next = Buffer.from(text, 'utf8');
  if (next.length > MAX_EDIT_BYTES) throw new WorkspaceEditError(413, '文件超过在线编辑上限');
  if (next.toString('utf8') !== text) throw new WorkspaceEditError(400, '文件包含无效 UTF-8 文本');

  const key = `${filesystem.basePath ?? filesystem.id}:${path}`;
  const previous = pending.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    await assertExistingRegularFile(filesystem, path);
    let current: Uint8Array;
    try {
      const read = await filesystem.readFile(path);
      current = typeof read === 'string' ? Buffer.from(read, 'utf8') : read;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceEditError(404, '文件不存在');
      throw error;
    }
    if (current.length > MAX_EDIT_BYTES) throw new WorkspaceEditError(413, '文件超过在线编辑上限');
    if (!isWorkspaceText(current)) throw new WorkspaceEditError(409, '该文件不支持文本编辑');
    if (readWorkspaceVersion(current) !== expectedEtag) throw new WorkspaceEditError(412, '文件已被其他操作修改，请重新打开');
    const growth = Math.max(0, next.length - current.length);
    if (userId) {
      try {
        await assertHostWritable(growth);
        if (growth) await workspaceQuota.reserve(userId, growth, 0);
      } catch (error) {
        if (error instanceof QuotaExceededError) throw new WorkspaceEditError(413, error.message);
        if (error instanceof DiskProtectionError) throw new WorkspaceEditError(409, error.message);
        throw error;
      }
    }
    try { await filesystem.writeFile(path, next); }
    catch (error) {
      if (userId && growth) await workspaceQuota.release(userId, growth, 0);
      throw error;
    }
    if (userId && next.length < current.length) await workspaceQuota.release(userId, current.length - next.length, 0);
    return readWorkspaceVersion(next);
  });
  pending.set(key, operation);
  try { return await operation; }
  finally { if (pending.get(key) === operation) pending.delete(key); }
}
