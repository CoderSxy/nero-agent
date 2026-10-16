import type { Pool, PoolClient } from 'pg';
import { getPool } from '../auth/db';
import type {
  PageQuery,
  RunFinishPatch,
  ScheduledTask,
  ScheduledTaskRun,
  TaskInput,
  TaskListQuery,
  TaskPatch,
  TriggerKind,
} from './types';

export type Queryable = Pick<Pool | PoolClient, 'query'>;

type TaskRow = {
  id: string;
  owner_user_id: string;
  mastra_schedule_id: string | null;
  name: string;
  task_type: 'cron';
  cron: string;
  timezone: string;
  prompt: string;
  chat_model_ref: string;
  memory_model_ref: string;
  starts_at: Date | null;
  ends_at: Date | null;
  status: ScheduledTask['status'];
  created_at: Date;
  updated_at: Date;
};

type RunRow = {
  id: string;
  task_id: string;
  owner_user_id: string;
  trigger_kind: TriggerKind;
  occurrence_key: string;
  fired_at: Date;
  thread_id: string | null;
  status: ScheduledTaskRun['status'];
  run_id: string | null;
  error_summary: string | null;
  finished_at: Date | null;
};

function dbOf(db?: Queryable): Queryable {
  return db ?? getPool();
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    mastraScheduleId: row.mastra_schedule_id,
    name: row.name,
    taskType: row.task_type,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    chatModelRef: row.chat_model_ref,
    memoryModelRef: row.memory_model_ref,
    startsAt: toIso(row.starts_at),
    endsAt: toIso(row.ends_at),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toRun(row: RunRow): ScheduledTaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    ownerUserId: row.owner_user_id,
    triggerKind: row.trigger_kind,
    occurrenceKey: row.occurrence_key,
    firedAt: row.fired_at.toISOString(),
    threadId: row.thread_id,
    status: row.status,
    runId: row.run_id,
    errorSummary: row.error_summary,
    finishedAt: toIso(row.finished_at),
  };
}

const TASK_COLUMNS = `
  id, owner_user_id, mastra_schedule_id, name, task_type, cron, timezone, prompt,
  chat_model_ref, memory_model_ref, starts_at, ends_at, status, created_at, updated_at
`;

const RUN_COLUMNS = `
  id, task_id, owner_user_id, trigger_kind, occurrence_key, fired_at, thread_id,
  status, run_id, error_summary, finished_at
`;

function parseOptionalTimestamp(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('invalid timestamp');
  return date;
}

export async function insertTask(
  ownerId: string,
  input: TaskInput,
  db?: Queryable,
): Promise<ScheduledTask> {
  const chatModelRef = input.chatModelRef ?? '';
  const memoryModelRef = input.memoryModelRef ?? '';
  const result = await dbOf(db).query<TaskRow>(
    `INSERT INTO agent_scheduled_tasks (
       owner_user_id, name, cron, timezone, prompt, chat_model_ref, memory_model_ref,
       starts_at, ends_at, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'paused')
     RETURNING ${TASK_COLUMNS}`,
    [
      ownerId,
      input.name,
      input.cron,
      input.timezone,
      input.prompt,
      chatModelRef,
      memoryModelRef,
      parseOptionalTimestamp(input.startsAt ?? null) ?? null,
      parseOptionalTimestamp(input.endsAt ?? null) ?? null,
    ],
  );
  return toTask(result.rows[0]);
}

export async function getTask(
  id: string,
  ownerId: string,
  db?: Queryable,
): Promise<ScheduledTask | null> {
  const result = await dbOf(db).query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM agent_scheduled_tasks
     WHERE id = $1 AND owner_user_id = $2 AND status <> 'deleted'`,
    [id, ownerId],
  );
  return result.rows[0] ? toTask(result.rows[0]) : null;
}

/** Lookup by id including soft-deleted rows (hooks / reconcile). */
export async function getTaskById(id: string, db?: Queryable): Promise<ScheduledTask | null> {
  const result = await dbOf(db).query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM agent_scheduled_tasks WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? toTask(result.rows[0]) : null;
}

export async function getTaskByMastraScheduleId(
  mastraScheduleId: string,
  db?: Queryable,
): Promise<ScheduledTask | null> {
  const result = await dbOf(db).query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM agent_scheduled_tasks WHERE mastra_schedule_id = $1`,
    [mastraScheduleId],
  );
  return result.rows[0] ? toTask(result.rows[0]) : null;
}

export async function listTasks(
  ownerId: string,
  query: TaskListQuery,
  db?: Queryable,
): Promise<{ items: ScheduledTask[]; total: number }> {
  const page = Math.max(1, query.page);
  const pageSize = Math.min(50, Math.max(1, query.pageSize));
  const offset = (page - 1) * pageSize;
  const q = query.q?.trim();
  const params: unknown[] = [ownerId];
  let filter = `owner_user_id = $1 AND status <> 'deleted'`;
  if (q) {
    params.push(`%${q}%`);
    filter += ` AND name ILIKE $${params.length}`;
  }
  const count = await dbOf(db).query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_scheduled_tasks WHERE ${filter}`,
    params,
  );
  params.push(pageSize, offset);
  const result = await dbOf(db).query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM agent_scheduled_tasks
     WHERE ${filter}
     ORDER BY updated_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    items: result.rows.map(toTask),
    total: Number(count.rows[0]?.count ?? 0),
  };
}

export async function updateTask(
  id: string,
  ownerId: string,
  patch: TaskPatch,
  db?: Queryable,
): Promise<ScheduledTask | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (patch.name !== undefined) push('name', patch.name);
  if (patch.cron !== undefined) push('cron', patch.cron);
  if (patch.timezone !== undefined) push('timezone', patch.timezone);
  if (patch.prompt !== undefined) push('prompt', patch.prompt);
  if (patch.chatModelRef !== undefined) push('chat_model_ref', patch.chatModelRef);
  if (patch.memoryModelRef !== undefined) push('memory_model_ref', patch.memoryModelRef);
  if (patch.startsAt !== undefined) push('starts_at', parseOptionalTimestamp(patch.startsAt) ?? null);
  if (patch.endsAt !== undefined) push('ends_at', parseOptionalTimestamp(patch.endsAt) ?? null);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.mastraScheduleId !== undefined) push('mastra_schedule_id', patch.mastraScheduleId);

  if (!sets.length) return getTask(id, ownerId, db);

  sets.push('updated_at = now()');
  params.push(id, ownerId);
  const result = await dbOf(db).query<TaskRow>(
    `UPDATE agent_scheduled_tasks
     SET ${sets.join(', ')}
     WHERE id = $${params.length - 1} AND owner_user_id = $${params.length}
     RETURNING ${TASK_COLUMNS}`,
    params,
  );
  return result.rows[0] ? toTask(result.rows[0]) : null;
}

export async function claimRun(
  taskId: string,
  kind: TriggerKind,
  occurrenceKey: string,
  firedAt: Date,
  db?: Queryable,
): Promise<{ run: ScheduledTaskRun; created: boolean }> {
  const client = dbOf(db);
  const task = await client.query<{ owner_user_id: string }>(
    `SELECT owner_user_id FROM agent_scheduled_tasks WHERE id = $1`,
    [taskId],
  );
  const ownerUserId = task.rows[0]?.owner_user_id;
  if (!ownerUserId) throw new Error(`scheduled task not found: ${taskId}`);

  try {
    const inserted = await client.query<RunRow>(
      `INSERT INTO agent_scheduled_task_runs (
         task_id, owner_user_id, trigger_kind, occurrence_key, fired_at, status
       ) VALUES ($1, $2, $3, $4, $5, 'preparing')
       ON CONFLICT (task_id, trigger_kind, occurrence_key) DO NOTHING
       RETURNING ${RUN_COLUMNS}`,
      [taskId, ownerUserId, kind, occurrenceKey, firedAt],
    );
    if (inserted.rows[0]) return { run: toRun(inserted.rows[0]), created: true };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== '23505' || kind !== 'manual') throw error;
  }

  const existing = await client.query<RunRow>(
    kind === 'manual'
      ? `SELECT ${RUN_COLUMNS} FROM agent_scheduled_task_runs
         WHERE task_id = $1 AND (
           (trigger_kind = $2 AND occurrence_key = $3)
           OR (trigger_kind = 'manual' AND status IN ('preparing', 'running'))
         )
         ORDER BY
           CASE WHEN trigger_kind = $2 AND occurrence_key = $3 THEN 0 ELSE 1 END,
           fired_at DESC
         LIMIT 1`
      : `SELECT ${RUN_COLUMNS} FROM agent_scheduled_task_runs
         WHERE task_id = $1 AND trigger_kind = $2 AND occurrence_key = $3
         LIMIT 1`,
    [taskId, kind, occurrenceKey],
  );
  if (!existing.rows[0]) throw new Error(`failed to claim run for task ${taskId}`);
  return { run: toRun(existing.rows[0]), created: false };
}

export async function finishRun(
  runId: string,
  patch: RunFinishPatch,
  db?: Queryable,
): Promise<ScheduledTaskRun | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (patch.status !== undefined) push('status', patch.status);
  if (patch.threadId !== undefined) push('thread_id', patch.threadId);
  if (patch.runId !== undefined) push('run_id', patch.runId);
  if (patch.errorSummary !== undefined) push('error_summary', patch.errorSummary);
  if (patch.finishedAt !== undefined) {
    const value = patch.finishedAt === null
      ? null
      : patch.finishedAt instanceof Date
        ? patch.finishedAt
        : new Date(patch.finishedAt);
    push('finished_at', value);
  }

  if (!sets.length) {
    const current = await dbOf(db).query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM agent_scheduled_task_runs WHERE id = $1`,
      [runId],
    );
    return current.rows[0] ? toRun(current.rows[0]) : null;
  }

  params.push(runId);
  const result = await dbOf(db).query<RunRow>(
    `UPDATE agent_scheduled_task_runs
     SET ${sets.join(', ')}
     WHERE id = $${params.length}
     RETURNING ${RUN_COLUMNS}`,
    params,
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

/** Atomically assign one worker to a claimed run before any thread is created. */
export async function startRun(runId: string, db?: Queryable): Promise<boolean> {
  const result = await dbOf(db).query(
    `UPDATE agent_scheduled_task_runs SET status = 'running'
     WHERE id = $1 AND status = 'preparing' RETURNING id`,
    [runId],
  );
  return result.rows.length === 1;
}

/** Expire abandoned claims so a crashed worker cannot block manual retries forever. */
export async function recoverStaleRuns(taskId?: string, db?: Queryable): Promise<number> {
  const result = await dbOf(db).query(
    `UPDATE agent_scheduled_task_runs
     SET status = 'failed', error_summary = '执行超时或服务中断', finished_at = now()
     WHERE ($1::uuid IS NULL OR task_id = $1)
       AND ((status = 'preparing' AND created_at < now() - interval '10 minutes')
         OR (status = 'running' AND created_at < now() - interval '24 hours'))`,
    [taskId ?? null],
  );
  return result.rowCount ?? 0;
}

export async function listRuns(
  taskId: string,
  ownerId: string,
  page: PageQuery,
  db?: Queryable,
): Promise<{ items: ScheduledTaskRun[]; total: number }> {
  const pageNum = Math.max(1, page.page);
  const pageSize = Math.min(50, Math.max(1, page.pageSize));
  const offset = (pageNum - 1) * pageSize;

  const count = await dbOf(db).query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_scheduled_task_runs
     WHERE task_id = $1 AND owner_user_id = $2`,
    [taskId, ownerId],
  );
  const result = await dbOf(db).query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM agent_scheduled_task_runs
     WHERE task_id = $1 AND owner_user_id = $2
     ORDER BY fired_at DESC, id DESC
     LIMIT $3 OFFSET $4`,
    [taskId, ownerId, pageSize, offset],
  );
  return {
    items: result.rows.map(toRun),
    total: Number(count.rows[0]?.count ?? 0),
  };
}

export async function getRunStats(
  taskId: string,
  ownerId: string,
  db?: Queryable,
): Promise<{ lastFireAt: string | null; execCount: number }> {
  const result = await dbOf(db).query<{ last_fire_at: Date | null; exec_count: string }>(
    `SELECT max(fired_at) AS last_fire_at, count(*)::text AS exec_count
     FROM agent_scheduled_task_runs
     WHERE task_id = $1 AND owner_user_id = $2`,
    [taskId, ownerId],
  );
  const row = result.rows[0];
  return {
    lastFireAt: toIso(row?.last_fire_at ?? null),
    execCount: Number(row?.exec_count ?? 0),
  };
}
