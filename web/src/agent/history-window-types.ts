import type { MastraDBMessage } from '@mastra/core/agent/message-list';

export const HISTORY_CACHE_TTL_MS = 30_000;
export const HISTORY_CACHE_MAX_THREADS = 5;
export const HISTORY_CACHE_MAX_BYTES = 10_485_760;

export type HistoryTurn = {
  turnId: string;
  originMessageId: string | null;
  provisional: boolean;
  replacesTurnIds?: string[];
  messageIds: string[];
  partialBefore: boolean;
  partialAfter: boolean;
  turnContext?: { messageId: string; preview: string };
};

export type HistoryWindow = {
  version: 1;
  thread: { id: string; resourceId: string; metadata?: unknown; updatedAt: string };
  messages: MastraDBMessage[];
  turns: HistoryTurn[];
  previousCursor: string | null;
  nextCursor: string | null;
  snapshotUpper: string | null;
  oversizedMessage: boolean;
};

export type HistoryStateMode = 'latest' | 'around';

export type HistoryScrollAnchor = {
  messageId: string;
  offsetTop: number;
} | null;

export type HistoryState = {
  thread: HistoryWindow['thread'] | null;
  messages: MastraDBMessage[];
  turns: HistoryTurn[];
  previousCursor: string | null;
  nextCursor: string | null;
  snapshotUpper: string | null;
  mode: HistoryStateMode;
  gap: boolean;
  scrollAnchor: HistoryScrollAnchor;
  oversizedMessage: boolean;
  turnAliases: Record<string, string>;
};

export function emptyHistoryState(mode: HistoryStateMode = 'latest'): HistoryState {
  return {
    thread: null,
    messages: [],
    turns: [],
    previousCursor: null,
    nextCursor: null,
    snapshotUpper: null,
    mode,
    gap: false,
    scrollAnchor: null,
    oversizedMessage: false,
    turnAliases: {},
  };
}
