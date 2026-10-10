import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultQuotaBytes, maxWorkspaceFiles } from './config';
import { assertContained, workspaceRoot } from './path';

export class QuotaExceededError extends Error {
  readonly status = 400;
  readonly code = 'WORKSPACE_QUOTA_EXCEEDED';
  constructor(message = '工作区已超过 500 MiB 上限，请删除无效或过期文件后再上传。') {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export type QuotaState = { usedBytes: number; fileCount: number; quotaBytes: number };
type ReservationState = QuotaState & { pendingBytes: number; pendingFiles: number };

const memory = new Map<string, ReservationState>();
const locks = new Map<string, Promise<void>>();

export class WorkspaceQuota {
  async reserve(userId: string, bytes: number, files = 1): Promise<void> {
    if (process.env.DATABASE_URL) {
      await this.mutateDatabase(userId, async (state, client) => {
        this.assertFits(state, bytes, files);
        state.usedBytes += bytes;
        state.fileCount += files;
        state.pendingBytes += bytes;
        state.pendingFiles += files;
        await this.writeDatabase(client, userId, state);
      });
      return;
    }
    await this.withLock(userId, async () => {
      const state = this.memoryState(userId);
      this.assertFits(state, bytes, files);
      state.usedBytes += bytes;
      state.fileCount += files;
      state.pendingBytes += bytes;
      state.pendingFiles += files;
      memory.set(userId, state);
    });
  }

  async release(userId: string, bytes: number, files = 0): Promise<void> {
    if (process.env.DATABASE_URL) {
      await this.mutateDatabase(userId, async (state, client) => {
        state.usedBytes = Math.max(0, state.usedBytes - bytes);
        state.fileCount = Math.max(0, state.fileCount - files);
        await this.writeDatabase(client, userId, state);
      });
      return;
    }
    await this.withLock(userId, async () => {
      const state = this.memoryState(userId);
      state.usedBytes = Math.max(0, state.usedBytes - bytes);
      state.fileCount = Math.max(0, state.fileCount - files);
      memory.set(userId, state);
    });
  }

  /** Undo a prior reserve (failed/aborted write): release quota and clear one in-flight mark. */
  async releaseReserve(userId: string, bytes: number, files = 0): Promise<void> {
    await this.settleReserve(userId, bytes, files, false);
  }

  /** Mark a successful reserve as settled (file on disk); does not change usedBytes. */
  async commit(userId: string, bytes: number, files = 0): Promise<void> {
    await this.settleReserve(userId, bytes, files, true);
  }

  hasInflightReserve(userId: string): boolean {
    const state = this.memoryState(userId);
    return state.pendingBytes > 0 || state.pendingFiles > 0;
  }

  async usage(userId: string): Promise<QuotaState> {
    const state = process.env.DATABASE_URL ? await this.loadDatabase(userId) : this.loadMemory(userId);
    return this.publicState(state);
  }

  async reconcileUsage(userId: string, usedBytes: number, fileCount: number): Promise<void> {
    await this.applyUsage(userId, usedBytes, fileCount, 'max');
  }

  /**
   * List/scan reconcile: replace from disk when no in-flight reserve (fixes stale over-count
   * after failed upload/crash); otherwise max-only so concurrent reserves are not wiped.
   */
  async reconcileForList(userId: string, usedBytes: number, fileCount: number): Promise<QuotaState> {
    await this.applyUsage(userId, usedBytes, fileCount, 'list');
    return this.usage(userId);
  }

  async reconcileFromDisk(userId: string): Promise<QuotaState> {
    // Keep the row/user lock while scanning, so a commit cannot race a stale snapshot.
    if (process.env.DATABASE_URL) {
      await this.mutateDatabase(userId, async (state, client) => {
        const counted = await scanPersonalWorkspace(workspaceRoot(userId));
        state.usedBytes = counted.usedBytes + state.pendingBytes;
        state.fileCount = counted.fileCount + state.pendingFiles;
        await this.writeDatabase(client, userId, state);
      });
    } else {
      await this.withLock(userId, async () => {
        const counted = await scanPersonalWorkspace(workspaceRoot(userId));
        const state = this.memoryState(userId);
        state.usedBytes = counted.usedBytes + state.pendingBytes;
        state.fileCount = counted.fileCount + state.pendingFiles;
        memory.set(userId, state);
      });
    }
    return this.usage(userId);
  }

  private async settleReserve(userId: string, bytes: number, files: number, committed: boolean): Promise<void> {
    const settle = (state: ReservationState) => {
      if (state.pendingBytes < bytes || state.pendingFiles < files) {
        throw new Error('Workspace quota reservation is missing');
      }
      state.pendingBytes -= bytes;
      state.pendingFiles -= files;
      if (!committed) {
        state.usedBytes = Math.max(0, state.usedBytes - bytes);
        state.fileCount = Math.max(0, state.fileCount - files);
      }
    };
    if (process.env.DATABASE_URL) {
      await this.mutateDatabase(userId, async (state, client) => {
        settle(state);
        await this.writeDatabase(client, userId, state);
      });
      return;
    }
    await this.withLock(userId, async () => {
      const state = this.memoryState(userId);
      settle(state);
      memory.set(userId, state);
    });
  }

  private async applyUsage(
    userId: string,
    usedBytes: number,
    fileCount: number,
    mode: 'max' | 'list',
  ): Promise<void> {
    const next = (state: ReservationState) => {
      if (mode === 'max') {
        state.usedBytes = Math.max(state.usedBytes, usedBytes);
        state.fileCount = Math.max(state.fileCount, fileCount);
      } else if (state.pendingBytes > 0 || state.pendingFiles > 0) {
        state.usedBytes = Math.max(state.usedBytes, usedBytes + state.pendingBytes);
        state.fileCount = Math.max(state.fileCount, fileCount + state.pendingFiles);
      } else {
        state.usedBytes = usedBytes;
        state.fileCount = fileCount;
      }
    };
    if (process.env.DATABASE_URL) {
      await this.mutateDatabase(userId, async (state, client) => {
        next(state);
        await this.writeDatabase(client, userId, state);
      });
      return;
    }
    await this.withLock(userId, async () => {
      const state = this.memoryState(userId);
      next(state);
      memory.set(userId, state);
    });
  }

  private assertFits(state: ReservationState, bytes: number, files: number) {
    if (state.fileCount + files > maxWorkspaceFiles()) throw new QuotaExceededError('文件数量超过上限');
    if (state.usedBytes + bytes > state.quotaBytes) throw new QuotaExceededError();
  }

  private memoryState(userId: string): ReservationState {
    return memory.get(userId) ?? {
      usedBytes: 0, fileCount: 0, quotaBytes: defaultQuotaBytes(), pendingBytes: 0, pendingFiles: 0,
    };
  }

  private loadMemory(userId: string): ReservationState {
    return { ...this.memoryState(userId) };
  }

  private publicState(state: ReservationState): QuotaState {
    return { usedBytes: state.usedBytes, fileCount: state.fileCount, quotaBytes: state.quotaBytes };
  }

  private async loadDatabase(userId: string): Promise<ReservationState> {
    const { getPool } = await import('../auth/db');
    const result = await getPool().query(
      'SELECT used_bytes, file_count, quota_bytes, pending_bytes, pending_files FROM app_workspaces WHERE user_id = $1',
      [userId],
    );
    if (result.rows[0]) {
      return {
        usedBytes: Number(result.rows[0].used_bytes),
        fileCount: Number(result.rows[0].file_count),
        quotaBytes: Number(result.rows[0].quota_bytes),
        pendingBytes: Number(result.rows[0].pending_bytes),
        pendingFiles: Number(result.rows[0].pending_files),
      };
    }
    return { usedBytes: 0, fileCount: 0, quotaBytes: defaultQuotaBytes(), pendingBytes: 0, pendingFiles: 0 };
  }

  private async mutateDatabase(
    userId: string,
    mutate: (state: ReservationState, client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<void>,
  ): Promise<void> {
    const { getPool } = await import('../auth/db');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO app_workspaces (user_id, workspace_id, root_path, quota_bytes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, `ws_${userId}`, workspaceRoot(userId), defaultQuotaBytes()],
      );
      const locked = await client.query(
        'SELECT used_bytes, file_count, quota_bytes, pending_bytes, pending_files FROM app_workspaces WHERE user_id = $1 FOR UPDATE',
        [userId],
      );
      const row = locked.rows[0];
      if (!row) throw new QuotaExceededError();
      const state: ReservationState = {
        usedBytes: Number(row.used_bytes),
        fileCount: Number(row.file_count),
        quotaBytes: Number(row.quota_bytes),
        pendingBytes: Number(row.pending_bytes),
        pendingFiles: Number(row.pending_files),
      };
      await mutate(state, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeDatabase(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    userId: string,
    state: ReservationState,
  ): Promise<void> {
    await client.query(
      `UPDATE app_workspaces SET used_bytes = $2, file_count = $3,
       pending_bytes = $4, pending_files = $5, updated_at = now() WHERE user_id = $1`,
      [userId, state.usedBytes, state.fileCount, state.pendingBytes, state.pendingFiles],
    );
  }

  private async withLock(userId: string, task: () => Promise<void>): Promise<void> {
    const previous = locks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    locks.set(userId, previous.then(() => current));
    await previous;
    try {
      await task();
    } finally {
      release();
    }
  }
}

async function scanPersonalWorkspace(root: string): Promise<{ usedBytes: number; fileCount: number }> {
  let usedBytes = 0;
  let fileCount = 0;
  async function walk(current: string): Promise<void> {
    let listed;
    try {
      listed = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of listed) {
      const full = join(current, entry.name);
      assertContained(root, full);
      let info;
      try {
        info = await lstat(full);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        usedBytes += info.size;
        fileCount += 1;
      }
    }
  }
  await walk(root);
  return { usedBytes, fileCount };
}

export const workspaceQuota = new WorkspaceQuota();
