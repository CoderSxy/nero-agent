import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { fetchHistoryWindow } from './history-window-client';
import { isUserMessage } from './pending-user-message';
import { historyCoversLive } from './chat-message-reconciliation';
import { mergeMessagesById } from './history-window-state';

function findLiveTurnStart(liveMessages: MastraDBMessage[]): MastraDBMessage | null {
  for (let i = liveMessages.length - 1; i >= 0; i--) {
    const message = liveMessages[i]!;
    if (isUserMessage(message)) return message;
  }
  return liveMessages[0] ?? null;
}

/** Bounded tail reconciliation: around/after the current live turn only. */
export async function reconcileThreadTail(options: {
  threadId: string;
  userId: string;
  liveMessages: MastraDBMessage[];
  signal?: AbortSignal;
  followLatest?: boolean;
}): Promise<MastraDBMessage[]> {
  void options.userId;
  const start = findLiveTurnStart(options.liveMessages);
  let page = await fetchHistoryWindow(options.threadId, {
    around: start?.id,
    signal: options.signal,
  });
  let messages = page.messages;
  const seen = new Set<string>();
  while (page.nextCursor && (options.followLatest || !historyCoversLive(messages, options.liveMessages))) {
    const cursor = page.nextCursor;
    if (seen.has(cursor)) throw new Error('历史续页游标未推进');
    seen.add(cursor);
    page = await fetchHistoryWindow(options.threadId, { after: cursor, signal: options.signal });
    messages = mergeMessagesById(messages, page.messages);
  }
  return messages;
}
