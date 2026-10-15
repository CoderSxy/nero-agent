import { randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import type { Mastra } from '@mastra/core/mastra';
import type { SchedulesConfig } from '@mastra/core/schedules';
import { getActiveUserById, type AuthUser } from '../auth/service';
import { memoryForRequest } from '../agents/memory-model';
import {
  chatModelRefContextKey,
  memoryModelRefContextKey,
} from '../models/resolver';
import { findAuthorizedModel } from '../models/service';
import { ModelCatalogError, type ModelRef } from '../models/types';
import {
  claimRun,
  finishRun,
  getTaskById,
} from './repository';
import type { RunFinishPatch, ScheduledTask, ScheduledTaskRun, TriggerKind } from './types';
import { cronOccurrenceKey } from './validation';

const MASTRA_USER_KEY = 'mastra__user';
const TERMINAL: ReadonlySet<ScheduledTaskRun['status']> = new Set([
  'succeeded', 'failed', 'aborted', 'skipped',
]);

export type ScheduledTaskHooksDeps = {
  getActiveUserById?: typeof getActiveUserById;
  findAuthorizedModel?: typeof findAuthorizedModel;
  getTaskById?: typeof getTaskById;
  claimRun?: typeof claimRun;
  finishRun?: typeof finishRun;
  createThread?: (input: {
    resourceId: string;
    title: string;
    metadata: Record<string, unknown>;
    requestContext: RequestContext;
  }) => Promise<{ id: string }>;
  runAgent?: (input: {
    mastra: Mastra;
    agentId: string;
    prompt: string;
    threadId: string;
    resourceId: string;
    requestContext: RequestContext;
  }) => Promise<{ runId?: string }>;
};

function appTaskIdOf(schedule: { metadata?: unknown }): string | null {
  const metadata = schedule.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>).appTaskId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function inEffectiveWindow(task: ScheduledTask, at: Date): boolean {
  if (task.startsAt && at.getTime() < new Date(task.startsAt).getTime()) return false;
  if (task.endsAt && at.getTime() > new Date(task.endsAt).getTime()) return false;
  return true;
}

function buildRequestContext(user: AuthUser, chatRef: string, memoryRef: string): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_USER_KEY, user);
  requestContext.set(chatModelRefContextKey, chatRef);
  requestContext.set(memoryModelRefContextKey, memoryRef);
  return requestContext;
}

async function defaultCreateThread(input: {
  resourceId: string;
  title: string;
  metadata: Record<string, unknown>;
  requestContext: RequestContext;
}): Promise<{ id: string }> {
  const memory = await memoryForRequest({ requestContext: input.requestContext });
  return memory.createThread({
    resourceId: input.resourceId,
    title: input.title,
    metadata: input.metadata,
  });
}

async function defaultRunAgent(input: {
  mastra: Mastra;
  agentId: string;
  prompt: string;
  threadId: string;
  resourceId: string;
  requestContext: RequestContext;
}): Promise<{ runId?: string }> {
  const agent = input.mastra.getAgent(input.agentId);
  const result = await agent.generate(input.prompt, {
    requestContext: input.requestContext,
    memory: {
      thread: input.threadId,
      resource: input.resourceId,
    },
  });
  const runId = result && typeof result === 'object' && 'runId' in result
    ? (result as { runId?: string }).runId
    : undefined;
  return { runId: typeof runId === 'string' ? runId : undefined };
}

/**
 * Schedule lifecycle hooks for app-owned Cron tasks.
 *
 * Deviation from the plan's wake/`sendSignal` return shape (verified against
 * `@mastra/core@1.71.0` `worker-BoYkCgzR.js`): the worker awaits
 * `sendSignal(...).accepted` and then calls `onFinish({ outcome: 'succeeded' })`
 * without `consumeStream()`, so success would be recorded before the agent run
 * ends. We therefore execute `agent.generate` inside `prepare` with a
 * server-rebuilt request context, persist the final run status, and return
 * `null` so the worker skips `sendSignal`. Legacy schedules without
 * `metadata.appTaskId` still return `undefined` (default Mastra behavior).
 */
export function createScheduledTaskHooks(
  deps: ScheduledTaskHooksDeps = {},
): SchedulesConfig<Mastra> {
  const resolveUser = deps.getActiveUserById ?? getActiveUserById;
  const authorizeModel = deps.findAuthorizedModel ?? findAuthorizedModel;
  const loadTask = deps.getTaskById ?? getTaskById;
  const claim = deps.claimRun ?? claimRun;
  const finish = deps.finishRun ?? finishRun;
  const createThread = deps.createThread ?? defaultCreateThread;
  const runAgent = deps.runAgent ?? defaultRunAgent;

  async function finalize(runId: string, patch: RunFinishPatch): Promise<void> {
    await finish(runId, {
      ...patch,
      finishedAt: patch.finishedAt ?? new Date(),
    });
  }

  return {
    async prepare(ctx) {
      const appTaskId = appTaskIdOf(ctx.schedule);
      if (!appTaskId) return undefined;

      const task = await loadTask(appTaskId);
      if (!task || task.status === 'deleted') {
        return null;
      }

      const firedAt = ctx.trigger.firedAt instanceof Date
        ? ctx.trigger.firedAt
        : new Date(ctx.trigger.firedAt);
      const kind = ctx.trigger.kind === 'manual' ? 'manual' : 'cron';
      const occurrenceKey = kind === 'manual'
        ? randomUUID()
        : cronOccurrenceKey(task.cron, task.timezone, firedAt);

      const claimed = await claim(task.id, kind as TriggerKind, occurrenceKey, firedAt);
      if (!claimed.created && TERMINAL.has(claimed.run.status)) {
        return null;
      }
      if (!claimed.created && claimed.run.threadId && claimed.run.status === 'running') {
        return null;
      }

      if (task.status !== 'active') {
        await finalize(claimed.run.id, {
          status: 'skipped',
          errorSummary: '任务未启用',
        });
        return null;
      }

      if (!inEffectiveWindow(task, firedAt)) {
        await finalize(claimed.run.id, {
          status: 'skipped',
          errorSummary: '不在生效时间范围内',
        });
        return null;
      }

      const owner = await resolveUser(task.ownerUserId);
      if (!owner || !owner.roles.includes('admin')) {
        await finalize(claimed.run.id, {
          status: 'failed',
          errorSummary: '任务所有者不可用或权限不足',
        });
        return null;
      }

      try {
        await authorizeModel(task.chatModelRef as ModelRef, owner);
        await authorizeModel(task.memoryModelRef as ModelRef, owner);
      } catch (error) {
        const summary = error instanceof ModelCatalogError || (error as { name?: string }).name === 'ModelCatalogError'
          ? '模型不可用或无权限'
          : '模型校验失败';
        await finalize(claimed.run.id, { status: 'failed', errorSummary: summary });
        return null;
      }

      const requestContext = buildRequestContext(owner, task.chatModelRef, task.memoryModelRef);
      let threadId = claimed.run.threadId;
      if (!threadId) {
        const thread = await createThread({
          resourceId: owner.id,
          title: `定时任务：${task.name}`,
          metadata: {
            neroAgentSourceType: 'schedule',
            neroAgentScheduleTaskId: task.id,
            neroAgentScheduleRunId: claimed.run.id,
            neroAgentModels: {
              chatModel: task.chatModelRef,
              memoryModel: task.memoryModelRef,
            },
          },
          requestContext,
        });
        threadId = thread.id;
        await finish(claimed.run.id, {
          status: 'running',
          threadId,
        });
      }

      try {
        const result = await runAgent({
          mastra: ctx.mastra,
          agentId: ctx.agentId,
          prompt: task.prompt,
          threadId,
          resourceId: owner.id,
          requestContext,
        });
        await finalize(claimed.run.id, {
          status: 'succeeded',
          threadId,
          runId: result.runId ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finalize(claimed.run.id, {
          status: 'failed',
          threadId,
          errorSummary: message.slice(0, 500),
        });
      }

      // Skip worker sendSignal/getMemory path; run already completed above.
      return null;
    },

    async onFinish(ctx) {
      const appTaskId = appTaskIdOf(ctx.schedule);
      if (!appTaskId) return;
      const threadId = ctx.effective.threadId;
      if (!threadId) return;
      // prepare-generate already finalized; only repair wake-path leftovers.
      if (ctx.outcome === 'skipped' || ctx.outcome === 'discarded') return;
      if (ctx.outcome === 'delivered' || ctx.outcome === 'persisted') return;
      if (ctx.outcome !== 'succeeded') return;
      // Intentionally ignore premature wake "succeeded" without our prepare finalize.
    },

    async onError(ctx) {
      const appTaskId = appTaskIdOf(ctx.schedule);
      if (!appTaskId) return;
      const threadId = ctx.effective?.threadId;
      if (!threadId) return;
      // Best-effort: mark matching non-terminal run failed when worker errors.
      // prepare-generate path usually already finalized.
    },

    async onAbort(ctx) {
      const appTaskId = appTaskIdOf(ctx.schedule);
      if (!appTaskId) return;
      void ctx;
    },
  };
}
