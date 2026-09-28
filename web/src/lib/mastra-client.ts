import { AGENT_ID, RESOURCE_ID } from '../constants';
import type { ThreadSummary } from './thread-label';
import { readSse } from './sse';
import { emptyTurn, reduceChunk, type AssistantTurn } from './stream-reducer';

export type FetchLike = typeof fetch;

type Chunk = { type: string; runId?: string; payload?: Record<string, unknown> };

function asThread(raw: Record<string, unknown>): ThreadSummary {
  return {
    id: String(raw.id),
    title: typeof raw.title === 'string' ? raw.title : undefined,
    createdAt: String(raw.createdAt),
    updatedAt: String(raw.updatedAt ?? raw.createdAt),
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata as Record<string, unknown> : undefined,
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Mastra ${response.status}`);
  return response.json();
}

export function createMastraClient(fetchImpl: FetchLike = fetch) {
  const threadQuery = `agentId=${AGENT_ID}&resourceId=${RESOURCE_ID}`;

  async function consumeSse(response: Response, onTurn: (turn: AssistantTurn) => void): Promise<AssistantTurn> {
    if (!response.ok) throw new Error(`Mastra ${response.status}`);
    if (!response.body) throw new Error('Mastra 503');
    let turn = emptyTurn();
    await readSse(response.body, (data) => {
      if (data === '[DONE]') return;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        return;
      }
      turn = reduceChunk(turn, chunk);
      onTurn(turn);
    });
    return turn;
  }

  return {
    async listThreads(): Promise<ThreadSummary[]> {
      const response = await fetchImpl(`/api/memory/threads?${threadQuery}&perPage=100&orderBy=updatedAt&sortDirection=DESC`);
      const body = await readJson(response) as { threads?: Record<string, unknown>[] };
      return (body.threads ?? []).map(asThread);
    },
    async createThread(title: string): Promise<ThreadSummary> {
      const response = await fetchImpl(`/api/memory/threads?agentId=${AGENT_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId: RESOURCE_ID, title }),
      });
      return asThread(await readJson(response) as Record<string, unknown>);
    },
    async getThread(threadId: string): Promise<ThreadSummary> {
      const response = await fetchImpl(`/api/memory/threads/${threadId}?${threadQuery}`);
      return asThread(await readJson(response) as Record<string, unknown>);
    },
    async getMessages(threadId: string): Promise<unknown[]> {
      const response = await fetchImpl(`/api/memory/threads/${threadId}/messages?${threadQuery}&perPage=40`);
      const body = await readJson(response) as { messages?: unknown[] };
      return body.messages ?? [];
    },
    streamMessage(threadId: string, text: string, onTurn: (turn: AssistantTurn) => void, signal?: AbortSignal) {
      return fetchImpl('/api/agents/agent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ messages: text, memory: { thread: threadId, resource: RESOURCE_ID } }),
      }).then((response) => consumeSse(response, onTurn));
    },
    async abortThread(threadId: string): Promise<void> {
      const response = await fetchImpl('/api/agents/agent/threads/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, resourceId: RESOURCE_ID }),
      });
      if (!response.ok) throw new Error(`Mastra ${response.status}`);
    },
    approveTool(runId: string, toolCallId: string, onTurn: (turn: AssistantTurn) => void) {
      return fetchImpl('/api/agents/agent/approve-tool-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, toolCallId }),
      }).then((response) => consumeSse(response, onTurn));
    },
    declineTool(runId: string, toolCallId: string, onTurn: (turn: AssistantTurn) => void) {
      return fetchImpl('/api/agents/agent/decline-tool-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, toolCallId }),
      }).then((response) => consumeSse(response, onTurn));
    },
  };
}
