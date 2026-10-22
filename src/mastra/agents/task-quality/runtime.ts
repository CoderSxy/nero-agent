import { randomUUID } from 'node:crypto';
import type { RequestContext } from '@mastra/core/request-context';
import { trustedAuth } from '../../auth/auth-context';
import { readBoundServerExecutionId, readBoundSkillThreadId } from '../../skills/execution-context';
import { finalizeRunOperation, reserveRunOperation } from './run-control-repository';
import { resolveTaskQualityMode, resolveTaskBudget } from './limits';
import type { BudgetKind } from './budget';
import type { TaskContract } from './types';

export class TaskBudgetExceeded extends Error {}
export type RunRuntime = {
  runId: string;
  enforce: boolean;
  suiteModelBudget?: { remaining: number };
  contract?: TaskContract;
  repairing: boolean;
  remaining?: {mainRequests:number;repairs:number;tools:number};
  activeMs: number;
  reportedMs: number;
  lastTick: number;
  paused: number;
  controller: AbortController;
  reserve(kind: BudgetKind, operationId: string): ReturnType<typeof reserveRunOperation>;
  finish(operationId: string, result: 'succeeded' | 'failed' | 'unconfirmed'): Promise<void>;
  remainingMs(): number;
};
const runtimes = new WeakMap<object, RunRuntime>();
export function getTaskRuntime(context?: RequestContext, deps = { reserve: reserveRunOperation, finish: finalizeRunOperation }): RunRuntime | undefined {
  if (!context) return;
  const runId = readBoundServerExecutionId(context);
  const threadId = readBoundSkillThreadId(context);
  if (!runId || !threadId) return;
  const previous = runtimes.get(context);
  if (previous?.runId === runId) return previous;
  const auth = trustedAuth(context);
  const mode = resolveTaskQualityMode(process.env.AGENT_TASK_QUALITY_MODE);
  const tick = () => {
    const delta = Math.max(0, performance.now() - runtime.lastTick);
    runtime.lastTick = performance.now();
    if (!runtime.paused) runtime.activeMs += delta;
    return runtime.paused ? 0 : delta;
  };
  const runtime: RunRuntime = {
    runId, enforce: mode === 'enforce', repairing: false, activeMs: 0, reportedMs: 0, lastTick: performance.now(), paused: 0,
    controller: new AbortController(),
    async reserve(kind, operationId) {
      tick();
      const elapsed = runtime.activeMs - runtime.reportedMs;
      runtime.reportedMs = runtime.activeMs;
      const result = await deps.reserve({userId:auth.userId,threadId}, {
        runId, operationId, kind, profile: runtime.contract?.profile ?? 'general', mode: runtime.enforce ? 'enforce' : 'observe', activeDeltaMs: elapsed,
        contract: runtime.contract,
      });
      runtime.remaining = result.remaining;
      if (result.activeMs !== undefined) { runtime.activeMs = result.activeMs; runtime.reportedMs = result.activeMs; }
      if (!result.allowed && !result.duplicate) {
        const error = new TaskBudgetExceeded(`已停止：${result.reason ?? '执行预算不可用'}，已有结果保留。`);
        runtime.controller.abort(error);
        throw error;
      }
      return result;
    },
    finish(operationId, result) { return deps.finish(runId, operationId, result); },
    remainingMs() {
      tick();
      return runtime.enforce ? Math.max(0, resolveTaskBudget(runtime.contract?.profile ?? 'general').activeMs - runtime.activeMs) : 1_800_000;
    },
  };
  runtimes.set(context, runtime);
  return runtime;
}
/** Runs only for the main model. Memory/title use the ordinary guarded transport. */
export function budgetModelFetch(runtime: RunRuntime, network: typeof fetch): typeof fetch {
  return async (input, init) => {
    const id = randomUUID();
    if (runtime.suiteModelBudget) {
      if (runtime.suiteModelBudget.remaining <= 0) throw new TaskBudgetExceeded('live 套件请求额度已耗尽');

    }
    await runtime.reserve(runtime.repairing ? 'repair-model' : 'main-model', id);
    if (runtime.suiteModelBudget) {
      if (runtime.suiteModelBudget.remaining <= 0) throw new TaskBudgetExceeded('live 套件请求额度已耗尽');
      runtime.suiteModelBudget.remaining -= 1;
    }
    const remaining = runtime.remainingMs();
    if (remaining <= 0) throw new TaskBudgetExceeded('活跃执行超时');
    const signal = AbortSignal.any([runtime.controller.signal, AbortSignal.timeout(Math.ceil(remaining)), ...(init?.signal ? [init.signal] : [])]);
    try {
      const response = await network(input, {...init, signal});
      // Keep the abort signal alive for streamed response consumption.
      await runtime.finish(id, response.ok ? 'succeeded' : 'failed');
      return response;
    } catch (error) { await runtime.finish(id, 'failed'); throw error; }
  };
}
