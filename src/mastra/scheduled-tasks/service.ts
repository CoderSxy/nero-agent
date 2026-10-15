import { randomUUID } from 'node:crypto';
import type { Mastra } from '@mastra/core/mastra';
import type { AuthUser } from '../auth/service';
import { findAuthorizedModel } from '../models/service';
import {
  claimRun,
  getRunStats,
  getTask,
  getTaskById,
  insertTask,
  listRuns,
  listTasks,
  updateTask,
} from './repository';
import type {
  PageQuery,
  RunDto,
  ScheduledTask,
  ScheduledTaskRun,
  TaskDto,
  TaskInput,
  TaskListQuery,
  TaskPatch,
  TriggerKind,
} from './types';
import {
  ScheduledTaskError,
  assertAdmin,
  computeNextFireAt,
  resolveDefaultModelRefs,
  validateTaskInput,
} from './validation';

export { ScheduledTaskError } from './validation';

export type ScheduleDriver = Pick<
  Mastra['schedules'],
  'create' | 'get' | 'update' | 'pause' | 'resume' | 'run' | 'delete' | 'list'
>;

export type ScheduledTaskServiceDeps = {
  driver: ScheduleDriver;
  agentId?: string;
  findAuthorizedModel?: typeof findAuthorizedModel;
  resolveDefaultModelRefs?: typeof resolveDefaultModelRefs;
  insertTask?: typeof insertTask;
  getTask?: typeof getTask;
  getTaskById?: typeof getTaskById;
  updateTask?: typeof updateTask;
  listTasks?: typeof listTasks;
  claimRun?: typeof claimRun;
  listRuns?: typeof listRuns;
  getRunStats?: typeof getRunStats;
};

export type ManualRunResult = {
  accepted: boolean;
  run: ScheduledTaskRun;
};

function requireOwned(
  task: ScheduledTask | null,
): asserts task is ScheduledTask {
  if (!task) throw new ScheduledTaskError('not_found', '任务不存在');
}

function toRunDto(run: ScheduledTaskRun): RunDto {
  const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : null;
  const firedAt = new Date(run.firedAt).getTime();
  return {
    id: run.id,
    taskId: run.taskId,
    triggerKind: run.triggerKind,
    firedAt: run.firedAt,
    threadId: run.threadId,
    status: run.status,
    errorSummary: run.errorSummary,
    finishedAt: run.finishedAt,
    durationMs: finishedAt === null ? null : Math.max(0, finishedAt - firedAt),
  };
}

async function toTaskDto(
  task: ScheduledTask,
  stats: { lastFireAt: string | null; execCount: number },
): Promise<TaskDto> {
  const { prompt: _prompt, ...rest } = task;
  return {
    ...rest,
    nextFireAt: task.status === 'active'
      ? computeNextFireAt(task.cron, task.timezone)
      : null,
    lastFireAt: stats.lastFireAt,
    execCount: stats.execCount,
  };
}

function isDeps(value: ScheduleDriver | ScheduledTaskServiceDeps): value is ScheduledTaskServiceDeps {
  return typeof value === 'object' && value !== null && 'driver' in value;
}

export function createScheduledTaskService(driverOrDeps: ScheduleDriver | ScheduledTaskServiceDeps) {
  const resolved: ScheduledTaskServiceDeps = isDeps(driverOrDeps)
    ? driverOrDeps
    : { driver: driverOrDeps };

  const driver = resolved.driver;
  const agentId = resolved.agentId ?? 'agent';
  const repo = {
    insertTask: resolved.insertTask ?? insertTask,
    getTask: resolved.getTask ?? getTask,
    getTaskById: resolved.getTaskById ?? getTaskById,
    updateTask: resolved.updateTask ?? updateTask,
    listTasks: resolved.listTasks ?? listTasks,
    claimRun: resolved.claimRun ?? claimRun,
    listRuns: resolved.listRuns ?? listRuns,
    getRunStats: resolved.getRunStats ?? getRunStats,
  };
  const authorize = resolved.findAuthorizedModel ?? findAuthorizedModel;
  const defaults = resolved.resolveDefaultModelRefs ?? resolveDefaultModelRefs;

  async function loadOwned(owner: AuthUser, id: string): Promise<ScheduledTask> {
    assertAdmin(owner);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new ScheduledTaskError('not_found', '任务不存在');
    }
    const row = await repo.getTask(id, owner.id);
    requireOwned(row);
    return row;
  }

  return {
    async create(owner: AuthUser, input: unknown): Promise<TaskDto> {
      const validated = await validateTaskInput(input, owner, {
        findAuthorizedModel: authorize,
        resolveDefaultModelRefs: defaults,
      });
      const row = await repo.insertTask(owner.id, validated);
      let scheduleId: string | null = null;
      try {
        const schedule = await driver.create({
          agentId,
          cron: validated.cron,
          timezone: validated.timezone,
          prompt: validated.prompt,
          name: validated.name,
          status: 'paused',
          metadata: { appTaskId: row.id },
        });
        scheduleId = schedule.id;
        const activated = await repo.updateTask(row.id, owner.id, {
          mastraScheduleId: schedule.id,
          status: 'active',
        });
        requireOwned(activated);
        await driver.resume(schedule.id);
        const stats = await repo.getRunStats(activated.id, owner.id);
        return toTaskDto(activated, stats);
      } catch (error) {
        if (scheduleId) {
          await driver.delete(scheduleId).catch(() => undefined);
        }
        await repo.updateTask(row.id, owner.id, { status: 'deleted' }).catch(() => undefined);
        if (error instanceof ScheduledTaskError) throw error;
        throw new ScheduledTaskError('upstream', '创建调度触发器失败');
      }
    },

    async get(owner: AuthUser, id: string): Promise<TaskDto> {
      const existing = await loadOwned(owner, id);
      const stats = await repo.getRunStats(existing.id, owner.id);
      return toTaskDto(existing, stats);
    },

    async edit(owner: AuthUser, id: string, input: unknown): Promise<TaskDto> {
      const existing = await loadOwned(owner, id);
      const validated = await validateTaskInput(input, owner, {
        findAuthorizedModel: authorize,
        resolveDefaultModelRefs: defaults,
      });
      if (!existing.mastraScheduleId) {
        throw new ScheduledTaskError('conflict', '任务触发器尚未就绪');
      }
      try {
        await driver.update(existing.mastraScheduleId, {
          cron: validated.cron,
          timezone: validated.timezone,
          prompt: validated.prompt,
          name: validated.name,
          metadata: { appTaskId: existing.id },
        });
      } catch {
        throw new ScheduledTaskError('upstream', '更新调度触发器失败');
      }
      const updated = await repo.updateTask(id, owner.id, {
        name: validated.name,
        cron: validated.cron,
        timezone: validated.timezone,
        prompt: validated.prompt,
        chatModelRef: validated.chatModelRef,
        memoryModelRef: validated.memoryModelRef,
        startsAt: validated.startsAt ?? null,
        endsAt: validated.endsAt ?? null,
      });
      requireOwned(updated);
      const stats = await repo.getRunStats(updated.id, owner.id);
      return toTaskDto(updated, stats);
    },

    async pause(owner: AuthUser, id: string): Promise<TaskDto> {
      const existing = await loadOwned(owner, id);
      if (!existing.mastraScheduleId) throw new ScheduledTaskError('conflict', '任务触发器尚未就绪');
      try {
        await driver.pause(existing.mastraScheduleId);
      } catch {
        throw new ScheduledTaskError('upstream', '暂停调度触发器失败');
      }
      const updated = await repo.updateTask(id, owner.id, { status: 'paused' });
      requireOwned(updated);
      const stats = await repo.getRunStats(updated.id, owner.id);
      return toTaskDto(updated, stats);
    },

    async resume(owner: AuthUser, id: string): Promise<TaskDto> {
      const existing = await loadOwned(owner, id);
      if (!existing.mastraScheduleId) throw new ScheduledTaskError('conflict', '任务触发器尚未就绪');
      try {
        await driver.resume(existing.mastraScheduleId);
      } catch {
        throw new ScheduledTaskError('upstream', '恢复调度触发器失败');
      }
      const updated = await repo.updateTask(id, owner.id, { status: 'active' });
      requireOwned(updated);
      const stats = await repo.getRunStats(updated.id, owner.id);
      return toTaskDto(updated, stats);
    },

    async run(owner: AuthUser, id: string): Promise<ManualRunResult> {
      const existing = await loadOwned(owner, id);
      if (existing.status !== 'active') {
        throw new ScheduledTaskError('conflict', '暂停的任务不能手动触发');
      }
      if (!existing.mastraScheduleId) {
        throw new ScheduledTaskError('conflict', '任务触发器尚未就绪');
      }
      const occurrenceKey = randomUUID();
      const claim = await repo.claimRun(existing.id, 'manual' as TriggerKind, occurrenceKey, new Date());
      if (!claim.created) {
        return { accepted: false, run: claim.run };
      }
      try {
        await driver.run(existing.mastraScheduleId);
      } catch (error) {
        // Leave preparing row for hooks/reconcile visibility; surface failure.
        throw new ScheduledTaskError('upstream', '手动触发失败');
      }
      return { accepted: true, run: claim.run };
    },

    async remove(owner: AuthUser, id: string): Promise<void> {
      const existing = await loadOwned(owner, id);
      if (existing.mastraScheduleId) {
        try {
          await driver.delete(existing.mastraScheduleId);
        } catch {
          throw new ScheduledTaskError('upstream', '删除调度触发器失败');
        }
      }
      const updated = await repo.updateTask(id, owner.id, {
        status: 'deleted',
        mastraScheduleId: null,
      });
      if (!updated) throw new ScheduledTaskError('not_found', '任务不存在');
    },

    async list(owner: AuthUser, query: TaskListQuery): Promise<{ items: TaskDto[]; total: number }> {
      assertAdmin(owner);
      const page = await repo.listTasks(owner.id, query);
      const items = await Promise.all(page.items.map(async (row) => {
        const stats = await repo.getRunStats(row.id, owner.id);
        return toTaskDto(row, stats);
      }));
      return { items, total: page.total };
    },

    async runs(
      owner: AuthUser,
      id: string,
      page: PageQuery,
    ): Promise<{ items: RunDto[]; total: number }> {
      assertAdmin(owner);
      const active = await repo.getTask(id, owner.id);
      const row = active ?? await repo.getTaskById(id);
      if (!row || row.ownerUserId !== owner.id) {
        throw new ScheduledTaskError('not_found', '任务不存在');
      }
      const result = await repo.listRuns(id, owner.id, page);
      return { items: result.items.map(toRunDto), total: result.total };
    },
  };
}

export type ScheduledTaskService = ReturnType<typeof createScheduledTaskService>;

/** Convenience factory for production wiring. */
export function createDefaultScheduledTaskService(driver: ScheduleDriver): ScheduledTaskService {
  return createScheduledTaskService({ driver });
}

export type { TaskPatch };
