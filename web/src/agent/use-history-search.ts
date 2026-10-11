import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildHistorySearchDocuments,
  RECENT_HISTORY_LIMIT,
  type HistorySearchDocument,
} from './history-search-index';
import type { HistorySearchCache } from './history-search-cache';
import { loadScopedThread, type Thread } from './thread-scope';

const LOAD_CONCURRENCY = 5;

type LoadThreadFn = typeof loadScopedThread;

type BatchStatus = 'idle' | 'loading' | 'ready' | 'error';

function threadUpdatedAtIso(thread: Pick<Thread, 'updatedAt'>): string {
  return new Date(thread.updatedAt).toISOString();
}

function collectDocuments(
  threads: Thread[],
  byThread: Map<string, HistorySearchDocument[]>,
): HistorySearchDocument[] {
  const documents: HistorySearchDocument[] = [];
  for (const thread of threads) {
    const docs = byThread.get(thread.id);
    if (docs) documents.push(...docs);
  }
  return documents;
}

async function loadThreadsWithConcurrency(
  threads: Thread[],
  options: {
    userId: string;
    cache: HistorySearchCache;
    loadThread: LoadThreadFn;
    invalidationEpoch: Map<string, number>;
    docsByThread: Map<string, HistorySearchDocument[]>;
    failedIds: Set<string>;
    isStale: () => boolean;
    onProgress: (completed: number, total: number) => void;
  },
): Promise<void> {
  const total = threads.length;
  if (total === 0) {
    if (!options.isStale()) options.onProgress(0, 0);
    return;
  }

  let completed = 0;
  let nextIndex = 0;

  const loadOne = async (thread: Thread) => {
    const threadId = thread.id;
    const epochAtStart = options.invalidationEpoch.get(threadId) ?? 0;
    const updatedAt = threadUpdatedAtIso(thread);
    try {
      const cached = await options.cache.get(options.userId, threadId, updatedAt);
      if (options.isStale()) return;
      if ((options.invalidationEpoch.get(threadId) ?? 0) !== epochAtStart) return;

      if (cached) {
        options.docsByThread.set(threadId, cached);
        options.failedIds.delete(threadId);
      } else {
        const result = await options.loadThread(threadId, options.userId);
        if (options.isStale()) return;
        if ((options.invalidationEpoch.get(threadId) ?? 0) !== epochAtStart) return;

        const docs = buildHistorySearchDocuments(result.thread, result.messages);
        await options.cache.put(options.userId, threadId, updatedAt, docs);
        if (options.isStale()) return;
        if ((options.invalidationEpoch.get(threadId) ?? 0) !== epochAtStart) return;

        options.docsByThread.set(threadId, docs);
        options.failedIds.delete(threadId);
      }
    } catch {
      if (options.isStale()) return;
      options.failedIds.add(threadId);
      options.docsByThread.delete(threadId);
    } finally {
      completed += 1;
      if (!options.isStale()) {
        options.onProgress(completed, total);
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(LOAD_CONCURRENCY, threads.length) },
    async () => {
      while (nextIndex < threads.length) {
        if (options.isStale()) return;
        const thread = threads[nextIndex];
        nextIndex += 1;
        await loadOne(thread);
      }
    },
  );

  await Promise.all(workers);
}

export function useHistorySearch(options: {
  userId: string;
  threads: Thread[];
  cache: HistorySearchCache;
  loadThread?: LoadThreadFn;
}) {
  const { userId, threads, cache, loadThread = loadScopedThread } = options;

  const [documents, setDocuments] = useState<HistorySearchDocument[]>([]);
  const [scope, setScope] = useState<'recent' | 'all'>('recent');
  const [recentStatus, setRecentStatus] = useState<BatchStatus>('idle');
  const [fullStatus, setFullStatus] = useState<BatchStatus>('idle');
  const [recentProgress, setRecentProgress] = useState({ completed: 0, total: 0 });
  const [fullProgress, setFullProgress] = useState({ completed: 0, total: 0 });
  const [recentFailedCount, setRecentFailedCount] = useState(0);
  const [fullFailedCount, setFullFailedCount] = useState(0);

  const generationRef = useRef(0);
  const fullLoadActiveRef = useRef(false);
  const docsByThreadRef = useRef(new Map<string, HistorySearchDocument[]>());
  const recentFailedRef = useRef(new Set<string>());
  const fullFailedRef = useRef(new Set<string>());
  const invalidationEpochRef = useRef(new Map<string, number>());
  const prevUserIdRef = useRef(userId);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const publishDocuments = useCallback((gen: number) => {
    if (gen !== generationRef.current) return;
    setDocuments(collectDocuments(threadsRef.current, docsByThreadRef.current));
  }, []);

  const resetForUser = useCallback((gen: number) => {
    docsByThreadRef.current.clear();
    recentFailedRef.current.clear();
    fullFailedRef.current.clear();
    invalidationEpochRef.current.clear();
    fullLoadActiveRef.current = false;
    setDocuments([]);
    setScope('recent');
    setRecentStatus('idle');
    setFullStatus('idle');
    setRecentProgress({ completed: 0, total: 0 });
    setFullProgress({ completed: 0, total: 0 });
    setRecentFailedCount(0);
    setFullFailedCount(0);
    publishDocuments(gen);
  }, [publishDocuments]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const userChanged = prevUserIdRef.current !== userId;
    prevUserIdRef.current = userId;
    if (userChanged) {
      generationRef.current += 1;
      resetForUser(generationRef.current);
    }

    const visibleIds = new Set(threads.map(thread => thread.id));
    for (const threadId of [...docsByThreadRef.current.keys()]) {
      if (!visibleIds.has(threadId)) {
        docsByThreadRef.current.delete(threadId);
      }
    }

    void cache.removeMissing(userId, visibleIds).catch(() => undefined);
    publishDocuments(generationRef.current);
  }, [userId, threads, cache, publishDocuments, resetForUser]);

  const runRecentBatch = useCallback(
    async (gen: number, targetThreads: Thread[]) => {
      setRecentStatus('loading');
      setRecentProgress({ completed: 0, total: targetThreads.length });

      await loadThreadsWithConcurrency(targetThreads, {
        userId,
        cache,
        loadThread,
        invalidationEpoch: invalidationEpochRef.current,
        docsByThread: docsByThreadRef.current,
        failedIds: recentFailedRef.current,
        isStale: () => gen !== generationRef.current,
        onProgress: (completed, total) => {
          if (gen !== generationRef.current) return;
          setRecentProgress({ completed, total });
          publishDocuments(gen);
        },
      });

      if (gen !== generationRef.current) return;

      const failures = recentFailedRef.current.size;
      setRecentFailedCount(failures);
      setRecentStatus(failures > 0 ? 'error' : 'ready');
      setScope('recent');
      publishDocuments(gen);
    },
    [cache, loadThread, publishDocuments, userId],
  );

  const runFullBatch = useCallback(
    async (gen: number, targetThreads: Thread[]) => {
      fullLoadActiveRef.current = true;
      setFullStatus('loading');
      setFullProgress({ completed: 0, total: targetThreads.length });

      await loadThreadsWithConcurrency(targetThreads, {
        userId,
        cache,
        loadThread,
        invalidationEpoch: invalidationEpochRef.current,
        docsByThread: docsByThreadRef.current,
        failedIds: fullFailedRef.current,
        isStale: () => gen !== generationRef.current,
        onProgress: (completed, total) => {
          if (gen !== generationRef.current) return;
          setFullProgress({ completed, total });
          publishDocuments(gen);
        },
      });

      fullLoadActiveRef.current = false;
      if (gen !== generationRef.current) return;

      const failures = fullFailedRef.current.size;
      setFullFailedCount(failures);
      setFullStatus(failures > 0 ? 'error' : 'ready');
      setScope(failures > 0 ? 'recent' : 'all');
      publishDocuments(gen);
    },
    [cache, loadThread, publishDocuments, userId],
  );

  const ensureRecent = useCallback(() => {
    if (recentStatus === 'loading' || recentStatus === 'ready') return;
    const gen = generationRef.current;
    const recentThreads = threadsRef.current.slice(0, RECENT_HISTORY_LIMIT);
    void runRecentBatch(gen, recentThreads).catch(() => undefined);
  }, [recentStatus, runRecentBatch]);

  const cancelRecent = useCallback(() => {
    if (!fullLoadActiveRef.current) {
      generationRef.current += 1;
    }
    setRecentStatus('idle');
    setRecentProgress({ completed: 0, total: 0 });
    setRecentFailedCount(0);
    recentFailedRef.current.clear();
    docsByThreadRef.current.clear();
    publishDocuments(generationRef.current);
  }, [publishDocuments]);

  const loadAll = useCallback(() => {
    if (fullStatus === 'loading' || fullStatus === 'ready') return;
    const gen = generationRef.current;
    const remainder = threadsRef.current.slice(RECENT_HISTORY_LIMIT);
    void runFullBatch(gen, remainder).catch(() => undefined);
  }, [fullStatus, runFullBatch]);

  const retryRecent = useCallback(() => {
    const failed = [...recentFailedRef.current];
    if (failed.length === 0) return;
    const gen = generationRef.current;
    const targets = threadsRef.current.filter(thread => failed.includes(thread.id));
    void runRecentBatch(gen, targets).catch(() => undefined);
  }, [runRecentBatch]);

  const retryFull = useCallback(() => {
    const failed = [...fullFailedRef.current];
    if (failed.length === 0) return;
    const gen = generationRef.current;
    const targets = threadsRef.current.filter(thread => failed.includes(thread.id));
    void runFullBatch(gen, targets).catch(() => undefined);
  }, [runFullBatch]);

  const invalidateThread = useCallback(
    async (threadId: string) => {
      const epoch = (invalidationEpochRef.current.get(threadId) ?? 0) + 1;
      invalidationEpochRef.current.set(threadId, epoch);
      docsByThreadRef.current.delete(threadId);
      publishDocuments(generationRef.current);

      try {
        await cache.invalidate(userId, threadId);
      } catch {
        // ignore cache errors; still attempt refresh
      }

      const thread = threadsRef.current.find(item => item.id === threadId);
      if (!thread) return;

      const gen = generationRef.current;
      const epochAtStart = invalidationEpochRef.current.get(threadId) ?? 0;
      const updatedAt = threadUpdatedAtIso(thread);

      try {
        const result = await loadThread(threadId, userId);
        if (gen !== generationRef.current) return;
        if ((invalidationEpochRef.current.get(threadId) ?? 0) !== epochAtStart) return;

        const docs = buildHistorySearchDocuments(result.thread, result.messages);
        await cache.put(userId, threadId, updatedAt, docs);
        if (gen !== generationRef.current) return;
        if ((invalidationEpochRef.current.get(threadId) ?? 0) !== epochAtStart) return;

        docsByThreadRef.current.set(threadId, docs);
        recentFailedRef.current.delete(threadId);
        fullFailedRef.current.delete(threadId);
        publishDocuments(gen);
      } catch {
        if (gen !== generationRef.current) return;
        recentFailedRef.current.add(threadId);
        setRecentFailedCount(recentFailedRef.current.size);
        setRecentStatus('error');
      }
    },
    [cache, loadThread, publishDocuments, userId],
  );

  return {
    documents,
    scope,
    recentStatus,
    fullStatus,
    recentProgress,
    fullProgress,
    recentFailedCount,
    fullFailedCount,
    ensureRecent,
    cancelRecent,
    loadAll,
    retryRecent,
    retryFull,
    invalidateThread,
  };
}
