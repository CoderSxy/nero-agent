import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createGuardedModelFetch } from '../../models/transport';

/** Billing purpose carried on the single budget seam. Processors never charge. */
export type TaskCallPurpose = 'chat' | 'memory' | 'title' | 'probe';

/** Kinds persisted for a main run. Auxiliary calls are visible but not main-budget. */
export type TaskOperationKind = 'main-model' | 'repair-model' | 'tool' | 'auxiliary';

export type TaskReservation = {
  operationId: string;
  kind: TaskOperationKind;
  purpose: TaskCallPurpose;
  runId: string | null;
  countsTowardMainBudget: boolean;
  duplicate: boolean;
};

export type TaskSeamLedger = {
  reservations: TaskReservation[];
};

export type TaskSeamContext = {
  /** Server-owned run id. Null when this call is not bound to the main answer. */
  runId: string | null;
  purpose: TaskCallPurpose;
  ledger: TaskSeamLedger;
};

const storage = new AsyncLocalStorage<TaskSeamContext>();

export function withTaskExecutionContext<T>(context: TaskSeamContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function readTaskExecutionContext(): TaskSeamContext | undefined {
  return storage.getStore();
}

/** Processors own policy and completion only. They are not a billing site. */
export function processorChargesBudget(): false {
  return false;
}

export function mainBudgetCount(ledger: TaskSeamLedger): number {
  return ledger.reservations.filter(item => item.countsTowardMainBudget).length;
}

function currentContext(): TaskSeamContext {
  const context = storage.getStore();
  if (!context) throw new Error('task execution context is not bound');
  return context;
}

function remember(context: TaskSeamContext, next: TaskReservation): TaskReservation {
  const existing = context.ledger.reservations.find(item => item.operationId === next.operationId);
  if (existing) return { ...existing, duplicate: true };
  context.ledger.reservations.push(next);
  return next;
}

function modelReservation(context: TaskSeamContext, attemptId: string): TaskReservation {
  const boundChat = context.purpose === 'chat' && context.runId !== null;
  return {
    operationId: attemptId,
    kind: boundChat ? 'main-model' : 'auxiliary',
    purpose: context.purpose,
    runId: context.runId,
    countsTowardMainBudget: boundChat,
    duplicate: false,
  };
}

/** One reservation per outbound model HTTP attempt. Cached replies never reach this function. */
export function reserveModelHttpAttempt(attemptId: string): TaskReservation {
  const id = attemptId.trim();
  if (!id) throw new Error('attemptId is required');
  const context = currentContext();
  return remember(context, modelReservation(context, id));
}

/** One reservation per tool start. Replays of the same call id do not add another charge. */
export function reserveToolStart(callId: string): TaskReservation {
  const id = callId.trim();
  if (!id) throw new Error('callId is required');
  const context = currentContext();
  const boundChat = context.purpose === 'chat' && context.runId !== null;
  return remember(context, {
    operationId: id,
    kind: 'tool',
    purpose: context.purpose,
    runId: context.runId,
    countsTowardMainBudget: boundChat,
    duplicate: false,
  });
}

/**
 * Outer seam around guarded model fetch.
 * URL/redirect checks still run before any network I/O; only a fetch that passes
 * those checks reserves a fresh attempt id. Callers without a seam context
 * (startup, unrelated tests) perform the guarded fetch and reserve nothing.
 */
export function createTaskBudgetFetch(baseUrl: URL, network: typeof fetch = globalThis.fetch): typeof fetch {
  return createGuardedModelFetch(baseUrl, async (input, init) => {
    if (storage.getStore()) reserveModelHttpAttempt(randomUUID());
    return network(input, init);
  });
}
