import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../auth/db';
import { resolveTaskBudget } from './config';
import type { BudgetKind, BudgetMode, BudgetReservation } from './budget';
import type { TaskProfile } from './types';

type Queryable = Pick<Pool | PoolClient, 'query'>;

const countColumn = { 'main-model': 'main_calls', 'repair-model': 'repair_calls', tool: 'tool_calls' } as const;

export async function reserveRunOperation(
  auth: { userId: string; threadId: string },
  input: { runId: string; operationId: string; kind: BudgetKind; profile: TaskProfile; mode: BudgetMode },
  db: Queryable = getPool(),
): Promise<BudgetReservation> {
  const client = 'connect' in db ? await (db as Pool).connect() : db as PoolClient;
  const release = 'connect' in db;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO app_agent_run_controls (run_id, user_id, thread_id, contract, profile, mode, status)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, 'active')
       ON CONFLICT (run_id) DO NOTHING`,
      [input.runId, auth.userId, auth.threadId, input.profile, input.mode],
    );
    const locked = await client.query<{
      user_id: string; profile: TaskProfile; status: string; main_calls: number; repair_calls: number; tool_calls: number;
    }>(
      `SELECT user_id, profile, status, main_calls, repair_calls, tool_calls
       FROM app_agent_run_controls WHERE run_id = $1 FOR UPDATE`,
      [input.runId],
    );
    const row = locked.rows[0];
    const limits = resolveTaskBudget(row?.profile ?? input.profile);
    const remaining = {
      mainRequests: Math.max(0, limits.mainRequests - (row?.main_calls ?? 0)),
      repairs: Math.max(0, limits.repairs - (row?.repair_calls ?? 0)),
      tools: Math.max(0, limits.tools - (row?.tool_calls ?? 0)),
    };
    if (!row || row.user_id !== auth.userId) {
      await client.query('ROLLBACK');
      return { allowed: false, duplicate: false, wouldStop: false, reason: 'owner', remaining };
    }
    const existing = await client.query(`SELECT 1 FROM app_agent_run_operations WHERE run_id = $1 AND operation_id = $2`, [input.runId, input.operationId]);
    if (existing.rowCount) {
      await client.query('COMMIT');
      return { allowed: false, duplicate: true, wouldStop: false, reason: 'duplicate', remaining };
    }
    const used = input.kind === 'main-model' ? row.main_calls : input.kind === 'repair-model' ? row.repair_calls : row.tool_calls;
    const limit = input.kind === 'main-model' ? limits.mainRequests : input.kind === 'repair-model' ? limits.repairs : limits.tools;
    if (row.status !== 'active' || (used >= limit && input.mode === 'enforce')) {
      await client.query('ROLLBACK');
      return { allowed: false, duplicate: false, wouldStop: used >= limit, reason: row.status !== 'active' ? 'inactive' : 'budget', remaining };
    }
    await client.query(
      `INSERT INTO app_agent_run_operations (run_id, operation_id, kind, status, started_at) VALUES ($1, $2, $3, 'reserved', now())`,
      [input.runId, input.operationId, input.kind],
    );
    await client.query(
      `UPDATE app_agent_run_controls SET ${countColumn[input.kind]} = ${countColumn[input.kind]} + 1, revision = revision + 1, updated_at = now() WHERE run_id = $1`,
      [input.runId],
    );
    await client.query('COMMIT');
    return {
      allowed: true,
      duplicate: false,
      wouldStop: used + 1 > limit,
      remaining: { ...remaining, [input.kind === 'main-model' ? 'mainRequests' : input.kind === 'repair-model' ? 'repairs' : 'tools']: Math.max(0, limit - used - 1) },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    if (release) client.release();
  }
}

export async function finalizeRunOperation(
  runId: string,
  operationId: string,
  result: 'succeeded' | 'failed' | 'unconfirmed',
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    `UPDATE app_agent_run_operations SET status = $3, finished_at = now()
     WHERE run_id = $1 AND operation_id = $2 AND status = 'reserved'`,
    [runId, operationId, result],
  );
}

export async function recordRunOutcome(runId: string, outcome: { revision: number; status: string }, db: Queryable = getPool()): Promise<number | undefined> {
  const status = outcome.status === 'failed' ? 'failed' : outcome.status === 'cancelled' ? 'cancelled' : 'completed';
  const result = await db.query<{ revision: number }>(
    `UPDATE app_agent_run_controls
        SET outcome = $2::jsonb,
            revision = revision + 1,
            status = CASE WHEN status = 'active' THEN $4 ELSE status END,
            updated_at = now()
      WHERE run_id = $1
        AND (outcome IS NULL OR COALESCE((outcome->>'revision')::bigint, 0) < $3)
      RETURNING revision`,
    [runId, JSON.stringify(outcome), outcome.revision, status],
  );
  return result.rows[0]?.revision;
}

export async function cleanupFinishedRuns(db: Queryable = getPool()): Promise<number> {
  const result = await db.query(
    `DELETE FROM app_agent_run_controls control
     WHERE control.status IN ('completed', 'failed', 'cancelled', 'interrupted')
       AND control.updated_at < now() - interval '30 days'
       AND NOT EXISTS (
         SELECT 1 FROM app_agent_run_operations operation
         WHERE operation.run_id = control.run_id AND operation.status IN ('reserved', 'unconfirmed')
       )`,
  );
  return result.rowCount ?? 0;
}
