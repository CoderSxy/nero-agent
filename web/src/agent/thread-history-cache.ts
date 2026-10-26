import {
  HISTORY_CACHE_MAX_BYTES,
  HISTORY_CACHE_MAX_THREADS,
  HISTORY_CACHE_TTL_MS,
  type HistoryState,
} from './history-window-types';

export type ThreadHistoryCacheEntry = {
  state: HistoryState;
  fetchedAt: number;
  bytes: number;
};

export type ThreadHistoryCache = {
  get(userId: string, threadId: string): ThreadHistoryCacheEntry | null;
  put(userId: string, threadId: string, state: HistoryState): void;
  invalidate(userId: string, threadId: string): void;
  delete(userId: string, threadId: string): void;
  clear(userId?: string): void;
  size(): number;
  totalBytes(): number;
};

function cacheKey(userId: string, threadId: string): string {
  return `${userId}:${threadId}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function estimateBytes(state: HistoryState): number {
  try {
    return byteLength(JSON.stringify({
      messages: state.messages.map((message) => message.id),
      turns: state.turns,
      cursors: [state.previousCursor, state.nextCursor, state.snapshotUpper],
    })) + state.messages.reduce((sum, message) => {
      try {
        return sum + byteLength(JSON.stringify(message.content ?? ''));
      } catch {
        return sum + 256;
      }
    }, 0);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function createThreadHistoryCache(
  options: { ttlMs?: number; maxThreads?: number; maxBytes?: number } = {},
): ThreadHistoryCache {
  const ttlMs = options.ttlMs ?? HISTORY_CACHE_TTL_MS;
  const maxThreads = options.maxThreads ?? HISTORY_CACHE_MAX_THREADS;
  const maxBytes = options.maxBytes ?? HISTORY_CACHE_MAX_BYTES;
  const entries = new Map<string, ThreadHistoryCacheEntry>();
  const order: string[] = [];

  function touch(key: string) {
    const index = order.indexOf(key);
    if (index >= 0) order.splice(index, 1);
    order.push(key);
  }

  function drop(key: string) {
    entries.delete(key);
    const index = order.indexOf(key);
    if (index >= 0) order.splice(index, 1);
  }

  function totalBytes(): number {
    let sum = 0;
    for (const entry of entries.values()) sum += entry.bytes;
    return sum;
  }

  function evict() {
    while (order.length > maxThreads || totalBytes() > maxBytes) {
      const oldest = order[0];
      if (!oldest) break;
      drop(oldest);
    }
  }

  return {
    get(userId, threadId) {
      const key = cacheKey(userId, threadId);
      const entry = entries.get(key);
      if (!entry) return null;
      touch(key);
      return entry;
    },
    put(userId, threadId, state) {
      const bytes = estimateBytes(state);
      if (bytes > maxBytes) return;
      const key = cacheKey(userId, threadId);
      entries.set(key, { state, fetchedAt: Date.now(), bytes });
      touch(key);
      evict();
    },
    invalidate(userId, threadId) {
      const entry = this.get(userId, threadId);
      if (!entry) return;
      entries.set(cacheKey(userId, threadId), { ...entry, fetchedAt: 0 });
    },
    delete(userId, threadId) {
      drop(cacheKey(userId, threadId));
    },
    clear(userId) {
      if (!userId) {
        entries.clear();
        order.length = 0;
        return;
      }
      for (const key of [...order]) {
        if (key.startsWith(`${userId}:`)) drop(key);
      }
    },
    size() {
      return entries.size;
    },
    totalBytes,
  };
}

export function isCacheFresh(entry: ThreadHistoryCacheEntry, now = Date.now(), ttlMs = HISTORY_CACHE_TTL_MS): boolean {
  return now - entry.fetchedAt <= ttlMs;
}
