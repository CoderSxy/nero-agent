import { useEffect, useMemo, useRef, useState } from 'react';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { hasRepeatedToolIds, historyCoversLive, reconcileChatMessages } from './chat-message-reconciliation';
import { isUserMessage } from './pending-user-message';
import { mergeMessagesById } from './history-window-state';
import { reconcileThreadTail } from './history-tail-client';

export function useReconciledChatMessages({
  messages,
  isRunning,
  threadId,
  resourceId,
}: {
  messages: MastraDBMessage[];
  isRunning: boolean;
  threadId: string;
  resourceId: string;
}) {
  const [snapshot, setSnapshot] = useState<{ key: string; messages: MastraDBMessage[] } | null>(null);
  const key = resourceId + ':' + threadId;
  const previous = useRef({ key, running: isRunning });
  const latest = useRef(messages);
  latest.current = messages;
  const stableLive = useRef(messages);
  if (
    messages.length !== stableLive.current.length ||
    messages.some((message, index) => message !== stableLive.current[index])
  ) {
    // Keep identity when callers pass an equal-by-id content snapshot? Prefer reference when identical ids+parts.
    const same =
      messages.length === stableLive.current.length &&
      messages.every((message, index) => {
        const prior = stableLive.current[index];
        return prior && prior.id === message.id && prior === message;
      });
    if (!same) stableLive.current = messages;
  }
  const duplicate = hasRepeatedToolIds(messages);
  useEffect(() => {
    const before = previous.current;
    previous.current = { key, running: isRunning };
    if (isRunning) {
      setSnapshot(null);
      return;
    }
    if (!(before.key === key && before.running) && !duplicate) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const sync = async (attempt: number) => {
      try {
        const all = latest.current;
        const start = all.map(isUserMessage).lastIndexOf(true);
        const liveTail = start < 0 ? all : all.slice(start);
        const history = await reconcileThreadTail({
          threadId,
          userId: resourceId,
          liveMessages: liveTail,
          signal: controller.signal,
        });
        if (!active) return;
        if (historyCoversLive(history, liveTail)) {
          setSnapshot({ key, messages: mergeMessagesById(all, history) });
          return;
        }
      } catch {
        /* Keep live data on transient history failures. */
      }
      if (active && attempt < 2) timer = setTimeout(() => void sync(attempt + 1), attempt === 0 ? 250 : 750);
    };
    void sync(0);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, isRunning, duplicate, threadId, resourceId]);

  return useMemo(() => reconcileChatMessages({
    history: snapshot?.key === key ? snapshot.messages : [], live: messages,
    settled: !isRunning && snapshot?.key === key,
  }), [snapshot, key, messages, isRunning]);
}
