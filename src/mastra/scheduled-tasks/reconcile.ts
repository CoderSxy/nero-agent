import { getPool } from '../auth/db';
import type { ScheduleDriver } from './service';
import { recoverStaleRuns, updateTask } from './repository';
import type { ScheduledTask } from './types';

type TaskRow = {
  id: string;
  owner_user_id: string;
  mastra_schedule_id: string | null;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  status: ScheduledTask['status'];
};

/**
 * Compare app task rows with Mastra schedules and repair drift.
 * - Missing triggers are recreated only for active/paused (non-deleted) tasks.
 * - Status drift is repaired toward the application table.
 * - Legacy schedules without appTaskId are ignored.
 * Failures are counted and processing continues.
 */
export async function reconcileScheduledTasks(
  driver: ScheduleDriver,
  agentId = 'agent',
  deps: {
    loadRows?: () => Promise<TaskRow[]>;
    updateTask?: typeof updateTask;
  } = {},
): Promise<{ repaired: number; failed: number }> {
  let repaired = 0;
  let failed = 0;
  const rows = deps.loadRows ? await deps.loadRows() : (await getPool().query<TaskRow>(
    `SELECT id, owner_user_id, mastra_schedule_id, name, cron, timezone, prompt, status
     FROM agent_scheduled_tasks WHERE status IN ('active', 'paused')`,
  )).rows;

  for (const row of rows) {
    try {
      const schedule = row.mastra_schedule_id
        ? await driver.get(row.mastra_schedule_id)
        : null;

      if (!schedule) {
        const created = await driver.create({
          agentId,
          cron: row.cron,
          timezone: row.timezone,
          prompt: row.prompt,
          name: row.name,
          status: row.status === 'active' ? 'active' : 'paused',
          metadata: { appTaskId: row.id },
        });
        try {
          const linked = await (deps.updateTask ?? updateTask)(row.id, row.owner_user_id, {
            mastraScheduleId: created.id,
            status: row.status,
          });
          if (!linked) throw new Error('scheduled task disappeared while linking trigger');
        } catch (error) {
          try {
            await driver.delete(created.id);
          } catch (rollbackError) {
            console.error('scheduled task reconcile cleanup failed', rollbackError);
          }
          throw error;
        }
        if (row.status === 'active' && created.status !== 'active') {
          await driver.resume(created.id);
        }
        if (row.status === 'paused' && created.status !== 'paused') {
          await driver.pause(created.id);
        }
        repaired += 1;
        continue;
      }

      if (!schedule.agentId) throw new Error('expected agent schedule');

      if (schedule.cron !== row.cron || schedule.timezone !== row.timezone
        || schedule.prompt !== row.prompt || schedule.name !== row.name
        || schedule.metadata?.appTaskId !== row.id) {
        await driver.update(schedule.id, {
          cron: row.cron, timezone: row.timezone, prompt: row.prompt,
          name: row.name, metadata: { appTaskId: row.id },
        });
        repaired += 1;
      }
      if (schedule.status === 'active' && row.status === 'paused') {
        await driver.pause(schedule.id);
        repaired += 1;
      } else if (schedule.status === 'paused' && row.status === 'active') {
        await driver.resume(schedule.id);
        repaired += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { repaired, failed };
}

/** Fire-and-forget startup reconcile that never blocks the process forever. */
export function startScheduledTaskReconcile(driver: ScheduleDriver): void {
  void (async () => {
    await recoverStaleRuns();
    await reconcileScheduledTasks(driver);
  })().catch((error) => {
    console.error('scheduled task reconcile failed', error instanceof Error ? error.name : 'unknown');
  });
}
