import type { Thread } from './thread-scope';

export type ThreadSource = 'default' | 'schedule';

const SOURCE_KEY = 'neroAgentSourceType';

export function sourceOfThread(metadata: unknown): ThreadSource {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'default';
  const value = (metadata as Record<string, unknown>)[SOURCE_KEY];
  return value === 'schedule' ? 'schedule' : 'default';
}

export function scheduledRunOfThread(metadata: unknown): { taskId: string; runId: string } | null {
  if (sourceOfThread(metadata) !== 'schedule') return null;
  const values = metadata as Record<string, unknown>;
  const taskId = values.neroAgentScheduleTaskId;
  const runId = values.neroAgentScheduleRunId;
  return typeof taskId === 'string' && taskId && typeof runId === 'string' && runId
    ? { taskId, runId } : null;
}

export function filterThreadsBySource(threads: Thread[], source: ThreadSource): Thread[] {
  return threads.filter((thread) => sourceOfThread(thread.metadata) === source);
}

export function withThreadSource(
  metadata: unknown,
  source: ThreadSource,
): Record<string, unknown> {
  const current = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return { ...current, [SOURCE_KEY]: source };
}
