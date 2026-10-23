import { apiFetch } from './client';
import { parseTurnArtifacts, type TurnArtifacts } from './turn-artifacts';

export async function listTurnArtifacts(
  threadId: string,
  options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<{ items: TurnArtifacts[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ threadId });
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const response = await apiFetch(`/current-workspace/turn-artifacts?${params}`, {
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `turn-artifacts ${response.status}`);
  }
  const body = await response.json() as { items?: unknown[]; nextCursor?: unknown };
  if (!Array.isArray(body.items)) throw new Error('Invalid turn-artifacts response');
  const items: TurnArtifacts[] = [];
  for (const item of body.items) {
    const parsed = parseTurnArtifacts(item);
    if (!parsed) throw new Error('Invalid turn-artifacts item');
    items.push(parsed);
  }
  const nextCursor = body.nextCursor === null || typeof body.nextCursor === 'string'
    ? body.nextCursor
    : null;
  return { items, nextCursor };
}
