import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultQuotaBytes, maxWorkspaceFiles } from './config';
import { assertContained, workspaceRoot } from './path';

export class QuotaExceededError extends Error {
  readonly status = 400;
  readonly code = 'WORKSPACE_QUOTA_EXCEEDED';
  constructor(message = '工作区配额已满') {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export type QuotaState = { usedBytes: number; fileCount: number; quotaBytes: number };

const memory = new Map<string, QuotaState>();
const locks = new Map<string, Promise<void>>();

export class WorkspaceQuota {
  async reserve(userId: string, bytes: number, files = 1): Promise<void> {
    if (process.env.DATABASE_URL) {
      await this.mutateDatabase(userId, async (state, client) => {
        this.assertFits(state, bytes, files);
        state.usedBytes += bytes;
        state.fileCount += files;
        await this.writeDatabase(client, userId, state);
      });
      return;
    }
    await this.withLock(userId, async () => {
      const state = await this.loadMemory(userId);
      this.assertFits(state, bytes, files);
      state.usedBytes += bytes;
      state.fileCount += files;
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
      const state = await this.loadMemory(userId);
      state.usedBytes = Math.max(0, state.usedBytes - bytes);
      state.fileCount = Math.max(0, state.fileCount - files);
      memory.set(userId, state);
    });
  }

  async commit(): Promise<void> {}

  async usage(userId: string): Promise<QuotaState> {
    if (process.env.DATABASE_URL) return this.loadDatabase(userId);
    return this.loadMemory(userId);
  }

  async reconcileUsage(userId: string, usedBytes: number, fileCount: number): Promise<void> {
    if (process.env.DATABASE_URL) {
      await this.mutateDatabase(userId, async (state, client) => {
        state.usedBytes = usedBytes;
        state.fileCount = fileCount;
        await this.writeDatabase(client, userId, state);
      });
      return;
    }
    await this.withLock(userId, async () => {
      const state = await this.loadMemory(userId);
      state.usedBytes = usedBytes;
      state.fileCount = fileCount;
      memory.set(userId, state);
    });
  }

  async reconcileFromDisk(userId: string): Promise<QuotaState> {
    const counted = await scanPersonalWorkspace(workspaceRoot(userId));
    await this.reconcileUsage(userId, counted.usedBytes, counted.fileCount);
    const usage = await this.usage(userId);
    return { ...usage, usedBytes: counted.usedBytes, fileCount: counted.fileCount };
  }

  private assertFits(state: QuotaState, bytes: number, files: number) {
    if (state.fileCount + files > maxWorkspaceFiles()) throw new QuotaExceededError('文件数量超过上限');
    if (state.usedBytes + bytes > state.quotaBytes) throw new QuotaExceededError();
  }

  private loadMemory(userId: string): QuotaState {
    return memory.get(userId) ?? { usedBytes: 0, fileCount: 0, quotaBytes: defaultQuotaBytes() };
  }

  private async loadDatabase(userId: string): Promise<QuotaState> {
    const { getPool } = await import('../auth/db');
    const result = await getPool().query(
      'SELECT used_bytes, file_count, quota_bytes FROM app_workspaces WHERE user_id = $1',
      [userId],
    );
    if (result.rows[0]) {
      return {
        usedBytes: Number(result.rows[0].used_bytes),
        fileCount: Number(result.rows[0].file_count),
        quotaBytes: Number(result.rows[0].quota_bytes),
      };
    }
    return { usedBytes: 0, fileCount: 0, quotaBytes: defaultQuotaBytes() };
  }

  private async mutateDatabase(
    userId: string,
    mutate: (state: QuotaState, client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<void>,
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
        'SELECT used_bytes, file_count, quota_bytes FROM app_workspaces WHERE user_id = $1 FOR UPDATE',
        [userId],
      );
      const row = locked.rows[0];
      if (!row) throw new QuotaExceededError();
      const state: QuotaState = {
        usedBytes: Number(row.used_bytes),
        fileCount: Number(row.file_count),
        quotaBytes: Number(row.quota_bytes),
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
    state: QuotaState,
  ): Promise<void> {
    await client.query(
      `UPDATE app_workspaces SET used_bytes = $2, file_count = $3, updated_at = now() WHERE user_id = $1`,
      [userId, state.usedBytes, state.fileCount],
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
