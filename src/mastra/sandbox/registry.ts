import type { SandboxInspect, SandboxOwner } from './types';

export type SandboxRecord = {
  userId: string;
  sandboxId: string;
  containerId?: string;
  status: SandboxInspect['status'];
  workspaceRoot?: string;
  lastActiveAt: number;
};

export class SandboxRegistry {
  private readonly memory = new Map<string, SandboxRecord>();

  async getByUser(userId: string): Promise<SandboxRecord | undefined> {
    if (process.env.DATABASE_URL) {
      const { getPool } = await import('../auth/db');
      const result = await getPool().query(
        `SELECT user_id, sandbox_id, container_id, status, workspace_root, last_active_at
         FROM app_sandbox_instances WHERE user_id = $1`,
        [userId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        userId: row.user_id,
        sandboxId: row.sandbox_id,
        containerId: row.container_id ?? undefined,
        status: row.status,
        workspaceRoot: row.workspace_root ?? undefined,
        lastActiveAt: new Date(row.last_active_at).getTime(),
      };
    }
    return this.memory.get(userId);
  }

  async upsert(record: SandboxRecord): Promise<void> {
    this.memory.set(record.userId, record);
    if (!process.env.DATABASE_URL) return;
    const { getPool } = await import('../auth/db');
    await getPool().query(
      `INSERT INTO app_sandbox_instances
        (user_id, sandbox_id, container_id, status, workspace_root, last_active_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
       ON CONFLICT (user_id) DO UPDATE SET
         sandbox_id = EXCLUDED.sandbox_id,
         container_id = EXCLUDED.container_id,
         status = EXCLUDED.status,
         workspace_root = EXCLUDED.workspace_root,
         last_active_at = EXCLUDED.last_active_at,
         updated_at = now()`,
      [
        record.userId,
        record.sandboxId,
        record.containerId ?? null,
        record.status,
        record.workspaceRoot ?? null,
        record.lastActiveAt,
      ],
    );
  }

  async clearContainer(owner: SandboxOwner, status: SandboxInspect['status']): Promise<void> {
    const current = (await this.getByUser(owner.userId)) ?? {
      userId: owner.userId,
      sandboxId: owner.sandboxId,
      status,
      lastActiveAt: Date.now(),
    };
    await this.upsert({ ...current, containerId: undefined, status });
  }
}
