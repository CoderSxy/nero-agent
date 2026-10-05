import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/auth-context';
import type { ThreadLookup } from '../auth/thread-guard';
import { ensureThreadDirectory } from '../workspace/manager';
import { assertContained, workspaceBase } from '../workspace/path';
import { FilePathError, maxFileSizeBytes, relativeFilePath } from './policy';

export class FileServiceError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404, message: string) {
    super(message);
    this.name = 'FileServiceError';
  }
}

export type FileListEntry = { path: string; type: 'file' | 'directory'; size: number };

export class FileService {
  constructor(private readonly lookup: ThreadLookup) {}

  async read(auth: AuthContext, threadId: string, relativePath: string) {
    const { hostPath, name } = await this.resolveOwnedPath(auth, threadId, relativePath);
    try {
      const data = await readFile(hostPath);
      return { data, name, hostPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileServiceError(404, '文件不存在');
      throw error;
    }
  }

  async write(
    auth: AuthContext,
    threadId: string,
    relativePath: string,
    data: Buffer,
    options: { signal?: AbortSignal } = {},
  ) {
    if (data.byteLength > maxFileSizeBytes()) throw new FileServiceError(400, '文件过大');
    const { hostPath } = await this.resolveOwnedPath(auth, threadId, relativePath, { create: true });
    if (options.signal?.aborted) throw new FileServiceError(400, '上传已中断');
    const tempPath = join(workspaceBase(), 'temp', randomUUID());
    await mkdir(dirname(tempPath), { recursive: true });
    try {
      const handle = await open(tempPath, 'wx');
      try {
        if (options.signal?.aborted) throw new FileServiceError(400, '上传已中断');
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      if (options.signal?.aborted) throw new FileServiceError(400, '上传已中断');
      await mkdir(dirname(hostPath), { recursive: true });
      await rename(tempPath, hostPath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async list(auth: AuthContext, threadId: string): Promise<FileListEntry[]> {
    const root = await this.ensureThreadRoot(auth, threadId);
    const entries: FileListEntry[] = [];
    await this.walk(root, root, entries);
    return entries;
  }

  async delete(auth: AuthContext, threadId: string, relativePath: string) {
    const { hostPath } = await this.resolveOwnedPath(auth, threadId, relativePath);
    try {
      await rm(hostPath, { recursive: true, force: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileServiceError(404, '文件不存在');
      throw error;
    }
  }

  private async ensureThreadRoot(auth: AuthContext, threadId: string) {
    const { hostPath } = await ensureThreadDirectory(auth, threadId, this.lookup);
    return hostPath;
  }

  private async resolveOwnedPath(
    auth: AuthContext,
    threadId: string,
    relativePath: string,
    options: { create?: boolean } = {},
  ) {
    const rel = relativeFilePath(relativePath);
    const root = await realpath(await this.ensureThreadRoot(auth, threadId));
    const hostPath = join(root, rel);
    assertContained(root, hostPath);
    await this.assertRealPath(root, hostPath, options.create === true);
    return { hostPath, name: rel.split('/').at(-1) ?? rel };
  }

  private async assertRealPath(root: string, hostPath: string, creating: boolean) {
    let current = creating ? dirname(hostPath) : hostPath;
    for (;;) {
      try {
        const real = await realpath(current);
        assertContained(root, real);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(current);
        if (parent === current) throw new FilePathError();
        current = parent;
      }
    }
  }

  private async walk(root: string, current: string, entries: FileListEntry[]) {
    const listed = await readdir(current, { withFileTypes: true });
    for (const entry of listed) {
      const full = join(current, entry.name);
      const rel = full.slice(root.length + 1).split('\\').join('/');
      if (entry.isDirectory()) {
        entries.push({ path: rel, type: 'directory', size: 0 });
        await this.walk(root, full, entries);
      } else if (entry.isFile()) {
        entries.push({ path: rel, type: 'file', size: (await stat(full)).size });
      }
    }
  }
}
