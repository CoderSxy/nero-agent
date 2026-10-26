import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { accumulateChunk } from '@mastra/react';
import { AGENT_ID, client } from './client';
import { listTaskRuns, type RunDto } from './scheduled-tasks-api';
import { reconcileThreadTail } from './history-tail-client';
import { mergeMessagesById } from './history-window-state';
import { isUserMessage } from './pending-user-message';

export type ScheduledRunRef = { taskId: string; runId: string };

const TERMINAL = new Set<RunDto['status']>(['succeeded', 'failed', 'aborted', 'skipped']);
const POLL_MS = 1_200;

function visibleProgress(messages: MastraDBMessage[]): number {
  return messages.reduce((total, message) => {
    const content: unknown = message.content;
    if (typeof content === 'string') return total + content.length;
    const parts = content && typeof content === 'object' && 'parts' in content && Array.isArray(content.parts)
      ? content.parts as MastraDBMessage['content']['parts'] : [];
    return total + parts.reduce((size, part) => {
      const value = part as typeof part & { text?: string; reasoning?: string;
        toolInvocation?: { state?: string; result?: unknown } };
      const tool = value.toolInvocation;
      const completedTool = tool && tool.state !== 'call' && tool.state !== 'partial-call';
      return size + 10 + (value.text?.length ?? value.reasoning?.length ?? 0) +
        (completedTool ? 100 : 0) + (tool?.result === undefined ? 0 : JSON.stringify(tool.result)?.length ?? 0);
    }, 0);
  }, 0);
}

async function findRun(run: ScheduledRunRef): Promise<RunDto | null> {
  let page = 1;
  for (;;) {
    const result = await listTaskRuns(run.taskId, { page, pageSize: 50 });
    const match = result.items.find(item => item.id === run.runId);
    if (match) return match;
    if (page * 50 >= result.total || result.items.length === 0) return null;
    page += 1;
  }
}

export function useScheduledThreadUpdates({ run, threadId, resourceId, setMessages, onSettled, initialMessages = [] }: {
  run?: ScheduledRunRef | null;
  threadId: string;
  resourceId: string;
  setMessages: Dispatch<SetStateAction<MastraDBMessage[]>>;
  initialMessages?: MastraDBMessage[];
  // Polling has its own accumulated tail; loaded UI history is merged, never replaced.
  onSettled?: () => void;
}): boolean {
  const [running, setRunning] = useState(Boolean(run));
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    if (!run) { setRunning(false); return; }
    let disposed = false;
    let finished = false;
    let streamed = false;
    let streamConversation: MastraDBMessage[] = [];
    const controller = new AbortController();
    let lastChunkAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: { unsubscribe: () => void } | undefined;
    setRunning(true);

    void client.getAgent(AGENT_ID).subscribeToThread({ threadId, resourceId }).then(response => {
      if (disposed || finished) { response.unsubscribe(); return; }
      subscription = response;
      void response.processDataStream({
        reconnect: true,
        onChunk: chunk => {
          if (disposed || finished) return;
          if (chunk.type === 'start') {
            if (streamed) streamConversation = [];
            streamed = true;
          }
          streamConversation = accumulateChunk({ chunk, conversation: streamConversation,
            metadata: { mode: 'stream', runId: chunk.runId } });
          if (!streamed) return;
          lastChunkAt = Date.now();
          setMessages(previous => mergeMessagesById(previous, streamConversation));
        },
      }).catch(() => { lastChunkAt = 0; });
    }).catch(() => { /* Storage polling remains available when subscription setup fails. */ });

    async function poll() {
      try {
        const current = await findRun(run!);
        if (disposed) return;
        const terminal = !current || TERMINAL.has(current.status);
        if (!streamed || Date.now() - lastChunkAt > 2_500 || terminal) {
          const anchorMessages = streamConversation.length ? streamConversation : initialMessages;
          const start = anchorMessages.map(isUserMessage).lastIndexOf(true);
          const snapshot = await reconcileThreadTail({ threadId, userId: resourceId,
            liveMessages: start >= 0 ? anchorMessages.slice(start) : anchorMessages,
            signal: controller.signal, followLatest: true });
          if (disposed) return;
          const saved = snapshot;
          setMessages(previous => {
            const byId = new Map(previous.map(message => [message.id, message]));
            const monotonic = saved.map(message => {
              const live = byId.get(message.id);
              return live && visibleProgress([live]) > visibleProgress([message]) ? live : message;
            });
            return mergeMessagesById(previous, monotonic);
          });
        }
        if (terminal) {
          finished = true;
          setRunning(false);
          subscription?.unsubscribe();
          onSettledRef.current?.();
          return;
        }
      } catch { /* A transient API failure should not freeze an active conversation. */ }
      if (!disposed) timer = setTimeout(() => { void poll(); }, POLL_MS);
    }
    void poll();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      subscription?.unsubscribe();
    };
  }, [run?.taskId, run?.runId, threadId, resourceId, setMessages]);
  return running;
}
