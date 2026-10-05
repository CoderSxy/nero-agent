import { defaultQuotaBytes, maxWorkspaceFiles } from './config';

export class QuotaExceededError extends Error {
  readonly status = 400;
  constructor(message = '工作区配额已满') {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

type QuotaState = { usedBytes: number; fileCount: number; quotaBytes: number };

const memory = new Map<string, QuotaState>();
const locks = new Map<string, Promise<void>>();

export class WorkspaceQuota {
  async reserve(userId: string, bytes: number, files = 1): Promise<void> {
    await this.withLock(userId, async () => {
      const state = await this.load(userId);
      if (state.fileCount + files > maxWorkspaceFiles()) throw new QuotaExceededError('文件数量超过上限');
      if (state.usedBytes + bytes > state.quotaBytes) throw new QuotaExceededError();
      state.usedBytes += bytes;
      state.fileCount += files;
      await this.save(userId, state);
    });
  }

  async release(userId: string, bytes: number, files = 0): Promise<void> {
    await this.withLock(userId, async () => {
      const state = await this.load(userId);
      state.usedBytes = Math.max(0, state.usedBytes - bytes);
      state.fileCount = Math.max(0, state.fileCount - files);
      await this.save(userId, state);
    });
  }

  async commit(): Promise<void> {}

  async usage(userId: string): Promise<QuotaState> {
    return this.load(userId);
  }

  async reconcileUsage(userId: string, usedBytes: number, fileCount: number): Promise<void> {
    await this.withLock(userId, async () => {
      const state = await this.load(userId);
      state.usedBytes = usedBytes;
      state.fileCount = fileCount;
      await this.save(userId, state);
    });
  }

  private async load(userId: string): Promise<QuotaState> {
    if (process.env.DATABASE_URL) {
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
    }
    return memory.get(userId) ?? { usedBytes: 0, fileCount: 0, quotaBytes: defaultQuotaBytes() };
  }

  private async save(userId: string, state: QuotaState): Promise<void> {
    memory.set(userId, state);
    if (!process.env.DATABASE_URL) return;
    const { getPool } = await import('../auth/db');
    await getPool().query(
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

export const workspaceQuota = new WorkspaceQuota();
