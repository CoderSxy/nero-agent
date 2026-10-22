import { resolveTaskBudget } from './limits';
import type { RunBudget, TaskProfile } from './types';

export type BudgetKind = 'main-model' | 'repair-model' | 'tool';
export type BudgetMode = 'observe' | 'enforce';

export type BudgetReservation = {
  allowed: boolean;
  duplicate: boolean;
  wouldStop: boolean;
  reason?: 'budget' | 'duplicate' | 'owner' | 'unavailable' | 'inactive';
  remaining: Pick<RunBudget, 'mainRequests' | 'repairs' | 'tools'>;
};

type Operation = { id: string; kind: BudgetKind; status: 'reserved' | 'succeeded' | 'failed' | 'unconfirmed' };
type RunState = {
  userId: string;
  threadId: string;
  profile: TaskProfile;
  mainCalls: number;
  repairCalls: number;
  toolCalls: number;
  activeMs: number;
  paused: boolean;
  status: 'active' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  repairToken: string | null;
  operations: Map<string, Operation>;
  updatedAt: number;
};

const field: Record<BudgetKind, 'mainCalls' | 'repairCalls' | 'toolCalls'> = {
  'main-model': 'mainCalls',
  'repair-model': 'repairCalls',
  tool: 'toolCalls',
};

const limitField: Record<BudgetKind, keyof RunBudget> = {
  'main-model': 'mainRequests',
  'repair-model': 'repairs',
  tool: 'tools',
};

export function localStopMessage(reason: string): string {
  return `已停止：${reason}。已有结果保留，不再请求模型总结。`;
}

export function createMemoryBudget(options: { failStorage?: boolean; now?: () => number } = {}) {
  const runs = new Map<string, RunState>();
  const tails = new Map<string, Promise<unknown>>();
  let cachedResponses = 0;
  const now = options.now ?? (() => Date.now());

  function remaining(state: RunState): BudgetReservation['remaining'] {
    const limits = resolveTaskBudget(state.profile);
    return {
      mainRequests: Math.max(0, limits.mainRequests - state.mainCalls),
      repairs: Math.max(0, limits.repairs - state.repairCalls),
      tools: Math.max(0, limits.tools - state.toolCalls),
    };
  }

  async function locked<T>(runId: string, work: () => Promise<T> | T): Promise<T> {
    const previous = tails.get(runId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    tails.set(runId, run);
    return run;
  }

  async function reserve(auth: { userId: string; threadId: string }, input: {
    runId: string;
    operationId: string;
    kind: BudgetKind;
    profile: TaskProfile;
    mode: BudgetMode;
    signal?: AbortSignal;
  }): Promise<BudgetReservation> {
    if (options.failStorage) {
      return { allowed: false, duplicate: false, wouldStop: false, reason: 'unavailable', remaining: { mainRequests: 0, repairs: 0, tools: 0 } };
    }
    return locked(input.runId, () => {
      if (input.signal?.aborted) {
        return { allowed: false, duplicate: false, wouldStop: false, reason: 'inactive', remaining: { mainRequests: 0, repairs: 0, tools: 0 } };
      }
      let state = runs.get(input.runId);
      if (state && state.userId !== auth.userId) {
        return { allowed: false, duplicate: false, wouldStop: false, reason: 'owner', remaining: remaining(state) };
      }
      if (!state) {
        state = {
          userId: auth.userId, threadId: auth.threadId, profile: input.profile, mainCalls: 0, repairCalls: 0, toolCalls: 0,
          activeMs: 0, paused: false, status: 'active', repairToken: null, operations: new Map(), updatedAt: now(),
        };
        runs.set(input.runId, state);
      }
      const existing = state.operations.get(input.operationId);
      if (existing) return { allowed: false, duplicate: true, wouldStop: false, reason: 'duplicate', remaining: remaining(state) };
      if (state.status !== 'active') {
        return { allowed: false, duplicate: false, wouldStop: false, reason: 'inactive', remaining: remaining(state) };
      }
      const limits = resolveTaskBudget(state.profile);
      const over = state[field[input.kind]] >= limits[limitField[input.kind]] || (!state.paused && state.activeMs > limits.activeMs);
      if (over && input.mode === 'enforce') {
        return { allowed: false, duplicate: false, wouldStop: true, reason: 'budget', remaining: remaining(state) };
      }
      state.operations.set(input.operationId, { id: input.operationId, kind: input.kind, status: 'reserved' });
      state[field[input.kind]] += 1;
      state.updatedAt = now();
      return { allowed: true, duplicate: false, wouldStop: over, remaining: remaining(state) };
    });
  }

  return {
    reserve,
    get cachedResponses() { return cachedResponses; },
    noteCachedResponse() { cachedResponses += 1; },
    async finalize(runId: string, operationId: string, result: 'succeeded' | 'failed' | 'unconfirmed') {
      const state = runs.get(runId);
      const operation = state?.operations.get(operationId);
      if (!operation || operation.status !== 'reserved') return;
      operation.status = result;
    },
    claimRepair(runId: string) {
      const state = runs.get(runId);
      if (!state) return { token: '', created: false };
      if (state.repairToken) return { token: state.repairToken, created: false };
      state.repairToken = `repair:${runId}`;
      return { token: state.repairToken, created: true };
    },
    pause(runId: string) {
      const state = runs.get(runId);
      if (state) state.paused = true;
    },
    resume(runId: string) {
      const state = runs.get(runId);
      if (state) state.paused = false;
    },
    addActive(runId: string, ms: number) {
      const state = runs.get(runId);
      if (state && !state.paused) state.activeMs += ms;
    },
    interrupt(runId: string) {
      const state = runs.get(runId);
      if (!state || state.status !== 'active') return;
      state.status = 'interrupted';
      for (const operation of state.operations.values()) {
        if (operation.status === 'reserved') operation.status = 'unconfirmed';
      }
    },
    cleanup(at: number) {
      let deleted = 0;
      for (const [runId, state] of runs) {
        const open = [...state.operations.values()].some(operation => operation.status === 'reserved' || operation.status === 'unconfirmed');
        if (state.status === 'active' || open || at - state.updatedAt < 30 * 24 * 60 * 60 * 1000) continue;
        runs.delete(runId);
        deleted += 1;
      }
      return deleted;
    },
  };
}
