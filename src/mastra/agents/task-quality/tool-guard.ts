import type { RunRuntime } from './runtime';
import { randomUUID } from 'node:crypto';
import { readTaskExecutionContext, reserveToolStart } from './execution-context';

type ToolContext = { toolCallId?: string; abortSignal?: AbortSignal };

type GuardableTool = {
  id?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  toModelOutput?: unknown;
  execute?: (input: never, context?: ToolContext) => Promise<unknown> | unknown;
};

/**
 * Reserve a tool start around execute without replacing the schema the model sees.
 * A duplicate call id returns the reservation and does not run execute again.
 */
const guardedExecutors = new WeakMap<Function, RunRuntime>();

export function guardTaskTool<T extends GuardableTool>(tool: T, runtime?: RunRuntime, toolName?: string): T {
  if (typeof tool.execute !== 'function') return tool;
  if (runtime && guardedExecutors.get(tool.execute) === runtime) return tool;
  const original = tool.execute;
  const guarded = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool) as T;
  guarded.inputSchema = tool.inputSchema;
  guarded.outputSchema = tool.outputSchema;
  guarded.toModelOutput = tool.toModelOutput;
  guarded.id = tool.id;
  guarded.execute = (async (input: never, context?: ToolContext) => {
    const callId = context?.toolCallId?.trim() || randomUUID();
    if (runtime) {
      const decision = await runtime.reserve('tool', callId);
      if (decision.duplicate) return { ok: false, code: 'RESULT_UNCONFIRMED', operationId: callId };
      const waiting = (toolName ?? tool.id) === 'ask_user';
      if (waiting) runtime.paused += 1;
      try {
        const remaining = runtime.remainingMs();
        const signal = AbortSignal.any([runtime.controller.signal, ...(!waiting ? [AbortSignal.timeout(Math.max(1, Math.ceil(remaining)))] : []), ...(context?.abortSignal ? [context.abortSignal] : [])]);
        const value = await original.call(tool, input, {...context, abortSignal: signal} as ToolContext);
        await runtime.finish(callId, 'succeeded');
        return value;
      } catch (error) { await runtime.finish(callId, 'failed'); throw error; }
      finally { if (waiting) { runtime.lastTick = performance.now(); runtime.paused -= 1; } }
    }
    if (!readTaskExecutionContext()) return original.call(tool, input, context);
    const gate = readTaskExecutionContext()?.budgetGate;
    if (gate) {
      const decision = await gate.reserve('tool', callId);
      if (decision.duplicate) return { duplicate: true, operationId: callId };
      if (!decision.allowed) return { stopped: true, operationId: callId, reason: decision.reason ?? 'budget' };
    }
    const reservation = reserveToolStart(callId);
    if (reservation.duplicate) return { duplicate: true, operationId: reservation.operationId };
    return original.call(tool, input, context);
  }) as T['execute'];
  if (runtime) guardedExecutors.set(guarded.execute!, runtime);
  return guarded;
}
