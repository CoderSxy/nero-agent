import { mkdir, open, lstat, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/auth-context';
import { ensureUserWorkspace } from '../workspace/manager';
import { assertContained, workspaceBase } from '../workspace/path';
import { workspaceQuota } from '../workspace/quota';
import { assertHostWritable } from '../workspace/disk-protection';
import { FilePathError, maxFileSizeBytes } from './policy';
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
      await workspaceQuota.release(auth.userId, data.byteLength, 1);
      throw new FileServiceError(400, '上传已中断');
    }
    const tempPath = join(workspaceBase(), 'temp', randomUUID());
    await mkdir(dirname(tempPath), { recursive: true });
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
      await workspaceQuota.commit();
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      await workspaceQuota.release(auth.userId, data.byteLength, 1).catch(() => undefined);
      throw error;
    }
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
    const regular = files.filter(entry => entry.type === 'file');
    const usedBytes = regular.reduce((sum, entry) => sum + entry.size, 0);
    await workspaceQuota.reconcileUsage(auth.userId, usedBytes, regular.length);
    const usage = await workspaceQuota.usage(auth.userId);
    return {
      files,
      usage: { usedBytes, quotaBytes: usage.quotaBytes, fileCount: regular.length },
    };
  }
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
