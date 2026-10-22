import { randomUUID } from 'node:crypto';
import { reserveToolStart } from './execution-context';

type ToolContext = { toolCallId?: string };

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
export function guardTaskTool<T extends GuardableTool>(tool: T): T {
  if (typeof tool.execute !== 'function') return tool;
  const original = tool.execute;
  const guarded = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool) as T;
  guarded.inputSchema = tool.inputSchema;
  guarded.outputSchema = tool.outputSchema;
  guarded.toModelOutput = tool.toModelOutput;
  guarded.id = tool.id;
  guarded.execute = (async (input: never, context?: ToolContext) => {
    const callId = context?.toolCallId?.trim() || randomUUID();
    const reservation = reserveToolStart(callId);
    if (reservation.duplicate) return { duplicate: true, operationId: reservation.operationId };
    return original.call(tool, input, context);
  }) as T['execute'];
  return guarded;
}
