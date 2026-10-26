/** Shared history-window protocol. UI history is independent of model memory. */

export const HISTORY_TURNS = 8;
export const HISTORY_MAX_MESSAGES = 200;
export const HISTORY_METADATA_BATCH = 100;
export const HISTORY_TARGET_BYTES = 524_288;
export const HISTORY_CACHE_TTL_MS = 30_000;
export const HISTORY_CACHE_MAX_THREADS = 5;
export const HISTORY_CACHE_MAX_BYTES = 10_485_760;
export const HISTORY_VIEWPORT_MARGIN_PX = 1000;
export const HISTORY_TEXT_PREVIEW_CHARS = 12_000;
export const HISTORY_CURSOR_MAX_BYTES = 4096;
export const HISTORY_SOFT_MIN_TURNS = 5;
export const HISTORY_TURN_CONTEXT_PREVIEW = 200;

export type HistoryPoint = {
  createdAt: string;
  id: string;
};

export type HistoryMetadata = {
  id: string;
  createdAt: string;
  role: string;
  type?: string;
  signalType?: string;
  contentBytes: number;
};

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

export type HistoryCursorDirection = 'before' | 'after';

export type HistoryCursorPayload = {
  version: 1;
  userId: string;
  threadId: string;
  direction: HistoryCursorDirection;
  boundary: HistoryPoint;
  snapshotUpper: HistoryPoint;
  openTurn?: { turnId: string };
};

export type HistorySliceMode = 'latest' | 'before' | 'around' | 'after';

export type HistorySliceResult = {
  ids: string[];
  turns: HistoryTurn[];
  hasBefore: boolean;
  hasAfter: boolean;
  oversizedMessage: boolean;
};

export type HistoryWindowData = {
  version: 1;
  messages: unknown[];
  turns: HistoryTurn[];
  previousCursor: string | null;
  nextCursor: string | null;
  snapshotUpper: string | null;
  oversizedMessage: boolean;
};

export type HistoryWindow = HistoryWindowData & {
  thread: {
    id: string;
    resourceId: string;
    metadata?: unknown;
    updatedAt: string;
  };
};
