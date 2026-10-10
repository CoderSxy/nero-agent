import { mkdir, open, lstat, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/auth-context';
import { ensureUserWorkspace } from '../workspace/manager';
import { assertContained, workspaceBase } from '../workspace/path';
import { workspaceQuota, type QuotaState } from '../workspace/quota';
import { assertHostWritable } from '../workspace/disk-protection';
import { FilePathError, maxFileSizeBytes, relativeFilePath } from './policy';
import { FileServiceError, type FileListEntry } from './service';
import { readWorkspaceVersion } from './workspace-editor';

export type WorkspaceFileEntry = {
  source: 'personal';
  path: string;
  name: string;
  size: number;
  mimeType: string;
  etag: string;
};

export type WorkspaceUsage = { usedBytes: number; quotaBytes: number; fileCount: number };

export type BatchDeleteItemResult = { path: string; ok: boolean; errorCode?: string };

export type BatchDeleteResult = {
  results: BatchDeleteItemResult[];
  deletedFiles: number;
  freedBytes: number;
  usage: QuotaState;
};

const MAX_BATCH_DELETE_PATHS = 100;
const PROTECTED_TOP_ROOTS = new Set(['shared', 'uploads', 'projects', 'threads']);
const PROTECTED_THREAD_LEAVES = new Set(['input', 'output', 'tmp']);

export class WorkspaceFileService {
  async upload(auth: AuthContext, file: File, signal?: AbortSignal): Promise<WorkspaceFileEntry> {
    const name = safeUploadName(file.name);
    const data = Buffer.from(await file.arrayBuffer());
    if (data.byteLength > maxFileSizeBytes()) throw new FileServiceError(413, '文件过大', 'FILE_TOO_LARGE');
    const root = await realpath(await ensureUserWorkspace(auth));
    const id = randomUUID();
    const relativePath = `uploads/${id}/${name}`;
    const hostPath = join(root, 'uploads', id, name);
    assertContained(root, hostPath);
    await assertExistingRealPath(root, dirname(hostPath));
    await assertHostWritable(data.byteLength);
    await workspaceQuota.reserve(auth.userId, data.byteLength, 1);
    if (signal?.aborted) {
      await workspaceQuota.releaseReserve(auth.userId, data.byteLength, 1);
      throw new FileServiceError(400, '上传已中断');
    }
    const tempPath = join(workspaceBase(), 'temp', randomUUID());
    await mkdir(dirname(tempPath), { recursive: true });
    let persisted = false;
    let committed = false;
    try {
      const handle = await open(tempPath, 'wx');
      try {
        if (signal?.aborted) throw new FileServiceError(400, '上传已中断');
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      if (signal?.aborted) throw new FileServiceError(400, '上传已中断');
      await mkdir(dirname(hostPath), { recursive: true });
      await assertExistingRealPath(root, dirname(hostPath));
      await rename(tempPath, hostPath);
      persisted = true;
      await workspaceQuota.commit(auth.userId, data.byteLength, 1);
      committed = true;
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      if (persisted && !committed) {
        try {
          await unlink(hostPath);
          persisted = false;
        } catch { /* Keep the reserve charged if the file could not be removed. */ }
      }
      if (!persisted) {
        await workspaceQuota.releaseReserve(auth.userId, data.byteLength, 1).catch(async () => {
          await workspaceQuota.reconcileFromDisk(auth.userId).catch(() => undefined);
        });
      }
      throw error;
    }
    // The committed reservation already charges this file. A failed audit must not
    // turn a persisted upload into an apparent failure or release its quota.
    await workspaceQuota.reconcileFromDisk(auth.userId).catch(() => undefined);
    return {
      source: 'personal',
      path: relativePath,
      name,
      size: data.byteLength,
      mimeType: file.type || 'application/octet-stream',
      etag: readWorkspaceVersion(data),
    };
  }

  async list(auth: AuthContext): Promise<{ files: FileListEntry[]; usage: WorkspaceUsage }> {
    const root = await realpath(await ensureUserWorkspace(auth));
    const files: FileListEntry[] = [];
    await walkWorkspace(root, root, files);
    // Re-scan while holding the quota row lock. The tree traversal above can race
    // a commit in another server process and must not replace its charged bytes.
    const usage = await workspaceQuota.reconcileFromDisk(auth.userId);
    return {
      files,
      usage: { usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes, fileCount: usage.fileCount },
    };
  }

  async batchDelete(auth: AuthContext, paths: string[]): Promise<BatchDeleteResult> {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new FileServiceError(400, '删除路径不能为空');
    }
    if (paths.length > MAX_BATCH_DELETE_PATHS) {
      throw new FileServiceError(400, `一次最多删除 ${MAX_BATCH_DELETE_PATHS} 个路径`);
    }

    const collapsed: string[] = [];
    const collapseErrors: BatchDeleteItemResult[] = [];
    for (const raw of paths) {
      try {
        collapsed.push(relativeFilePath(raw));
      } catch {
        collapseErrors.push({ path: String(raw ?? ''), ok: false, errorCode: 'INVALID_PATH' });
      }
    }
    const targets = collapseParentChildPaths(collapsed);
    if (targets.length > MAX_BATCH_DELETE_PATHS) {
      throw new FileServiceError(400, `一次最多删除 ${MAX_BATCH_DELETE_PATHS} 个路径`);
    }

    const root = await realpath(await ensureUserWorkspace(auth));
    const results: BatchDeleteItemResult[] = [...collapseErrors];
    let deletedFiles = 0;
    let freedBytes = 0;

    for (const relative of targets) {
      if (isProtectedWorkspacePath(relative)) {
        results.push({ path: relative, ok: false, errorCode: 'PROTECTED_PATH' });
        continue;
      }
      try {
        const hostPath = join(root, relative);
        assertContained(root, hostPath);
        const info = await lstat(hostPath);
        if (info.isSymbolicLink()) {
          results.push({ path: relative, ok: false, errorCode: 'SYMLINK' });
          continue;
        }
        await assertExistingRealPath(root, hostPath);
        if (!info.isFile() && !info.isDirectory()) {
          results.push({ path: relative, ok: false, errorCode: 'INVALID_PATH' });
          continue;
        }
        const entries: FileListEntry[] = [];
        if (info.isDirectory()) {
          await walkWorkspace(hostPath, hostPath, entries);
        } else {
          entries.push({ path: relative, type: 'file', size: info.size });
        }
        const files = entries.filter(entry => entry.type === 'file');
        const bytes = files.reduce((sum, entry) => sum + entry.size, 0);
        await rm(hostPath, { recursive: true, force: false });
        await workspaceQuota.release(auth.userId, bytes, files.length);
        deletedFiles += files.length;
        freedBytes += bytes;
        results.push({ path: relative, ok: true });
      } catch (error) {
        if (error instanceof FilePathError) {
          results.push({ path: relative, ok: false, errorCode: 'INVALID_PATH' });
          continue;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          results.push({ path: relative, ok: false, errorCode: 'NOT_FOUND' });
          continue;
        }
        results.push({ path: relative, ok: false, errorCode: 'DELETE_FAILED' });
      }
    }

    const usage = await workspaceQuota.reconcileFromDisk(auth.userId);
    return { results, deletedFiles, freedBytes, usage };
  }
}

export function collapseParentChildPaths(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort();
  const kept: string[] = [];
  for (const path of unique) {
    if (kept.some(parent => path === parent || path.startsWith(`${parent}/`))) continue;
    kept.push(path);
  }
  return kept;
}

export function isProtectedWorkspacePath(path: string): boolean {
  if (PROTECTED_TOP_ROOTS.has(path)) return true;
  const segments = path.split('/');
  if (segments.length === 2 && segments[0] === 'threads' && segments[1]) return true;
  if (segments.length === 3 && segments[0] === 'threads' && PROTECTED_THREAD_LEAVES.has(segments[2]!)) {
    return true;
  }
  return false;
}

export function safeUploadName(input: string): string {
  const base = input.replaceAll('\\', '/').split('/').pop() ?? '';
  const cleaned = [...base].filter(char => char !== '\0' && char !== '\r' && char !== '\n').join('').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new FilePathError();
  return cleaned;
}

export function addRecursiveDirectorySizes(entries: FileListEntry[]): FileListEntry[] {
  for (const entry of entries) {
    if (entry.type !== 'directory') continue;
    const prefix = `${entry.path}/`;
    entry.size = entries
      .filter(other => other.type === 'file' && other.path.startsWith(prefix))
      .reduce((sum, other) => sum + other.size, 0);
  }
  return entries;
}

async function assertExistingRealPath(root: string, hostPath: string) {
  let current = hostPath;
  for (;;) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new FilePathError();
      const real = await realpath(current);
      assertContained(root, real);
      return;
    } catch (error) {
      if (error instanceof FilePathError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw new FilePathError();
      current = parent;
    }
  }
}

async function walkWorkspace(root: string, current: string, entries: FileListEntry[]): Promise<number> {
  let listed;
  try {
    listed = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for (const entry of listed) {
    const full = join(current, entry.name);
    const rel = full.slice(root.length + 1).split('\\').join('/');
    let info;
    try {
      info = await lstat(full);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      const dirEntry: FileListEntry = { path: rel, type: 'directory', size: 0 };
      entries.push(dirEntry);
      dirEntry.size = await walkWorkspace(root, full, entries);
      total += dirEntry.size;
    } else if (info.isFile()) {
      entries.push({ path: rel, type: 'file', size: info.size });
      total += info.size;
    }
  }
  return total;
}
