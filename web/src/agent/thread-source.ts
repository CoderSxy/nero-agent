import type { Thread } from './thread-scope';

export type ThreadSource = 'default' | 'schedule';

const SOURCE_KEY = 'neroAgentSourceType';

export function sourceOfThread(metadata: unknown): ThreadSource {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'default';
  const value = (metadata as Record<string, unknown>)[SOURCE_KEY];
  return value === 'schedule' ? 'schedule' : 'default';
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
