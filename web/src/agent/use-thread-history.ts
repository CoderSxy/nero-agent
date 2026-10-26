import { useCallback, useEffect, useRef, useState } from 'react';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { fetchHistoryWindow, HistoryWindowError } from './history-window-client';
import { emptyHistoryState, mergeHistoryWindow, mergeLiveMessages } from './history-window-state';
import type { HistoryState } from './history-window-types';
import { createThreadHistoryCache, type ThreadHistoryCache } from './thread-history-cache';

export type UseThreadHistoryResult = {
  state: HistoryState;
  status: 'loading' | 'ready' | 'error';
  validating: boolean;
  authorized: boolean;
  loadingBefore: boolean;
  loadingAfter: boolean;
  error: string | null;
  errorStatus: number | null;
  loadBefore: () => Promise<void>;
  loadAfter: () => Promise<void>;
  goLatest: () => Promise<void>;
  retry: () => Promise<void>;
  mergeLive: (messages: MastraDBMessage[]) => void;
};

export function useThreadHistory(options: {
  userId: string | null | undefined;
  threadId: string | null | undefined;
  targetMessageId?: string | null;
  cache?: ThreadHistoryCache;
}): UseThreadHistoryResult {
  const { userId, threadId, targetMessageId, cache } = options;
  const scope = `${userId ?? ''}:${threadId ?? ''}`;
  const [entry, setEntry] = useState<{ scope: string; state: HistoryState }>({
    scope,
    state: emptyHistoryState(),
  });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [validating, setValidating] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loadingBefore, setLoadingBefore] = useState(false);
  const [loadingAfter, setLoadingAfter] = useState(false);
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const beforeFlight = useRef<Promise<void> | null>(null),
    afterFlight = useRef<Promise<void> | null>(null);
  const current = useRef(entry);
  current.current = entry;
  const cancel = useCallback(() => {
    generation.current++;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    beforeFlight.current = null;
    afterFlight.current = null;
    setLoadingBefore(false);
    setLoadingAfter(false);
  }, []);
  const fail = useCallback(
    (err: unknown, mode: 'latest' | 'around') => {
      const code = err instanceof HistoryWindowError ? err.status : null;
      setErrorStatus(code);
      setError(err instanceof Error ? err.message : '加载历史失败');
      if (code === 401 || code === 403 || code === 404) {
        if (userId && threadId) cache?.delete(userId, threadId);
        setEntry({ scope, state: emptyHistoryState(mode) });
        setStatus('error');
        setAuthorized(false);
      }
    },
    [cache, userId, threadId, scope],
  );
  const load = useCallback(
    async (latest = false) => {
      cancel();
      const gen = generation.current;
      const mode = !latest && targetMessageId ? 'around' : 'latest';
      setError(null);
      setErrorStatus(null);
      setAuthorized(false);
      if (!userId || !threadId) {
        setEntry({ scope, state: emptyHistoryState() });
        setStatus('ready');
        setValidating(false);
        return;
      }
      const cached = mode === 'latest' ? cache?.get(userId, threadId) : null;
      const retained =
        current.current.scope === scope && current.current.state.thread ? current.current.state : null;
      if (retained) {
        setEntry({ scope, state: retained });
        setStatus('ready');
      } else if (cached) {
        setEntry({ scope, state: cached.state });
        setStatus('ready');
      } else {
        setEntry({ scope, state: emptyHistoryState(mode) });
        setStatus('loading');
      }
      setValidating(true);
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const page = await fetchHistoryWindow(threadId, {
          around: mode === 'around' ? targetMessageId! : undefined,
          signal: controller.signal,
        });
        if (gen !== generation.current || controller.signal.aborted) return;
        const next = mergeHistoryWindow(emptyHistoryState(mode), page, 'replace');
        setEntry({ scope, state: next });
        setStatus('ready');
        setAuthorized(true);
        cache?.put(userId, threadId, next);
      } catch (err) {
        if (gen !== generation.current || controller.signal.aborted) return;
        fail(err, mode);
        if (!(err instanceof HistoryWindowError && [401, 403, 404].includes(err.status)))
          setStatus(cached || retained ? 'ready' : 'error');
      } finally {
        controllers.current.delete(controller);
        if (gen === generation.current) setValidating(false);
      }
    },
    [cancel, cache, fail, scope, targetMessageId, threadId, userId],
  );
  useEffect(() => {
    void load();
    return cancel;
  }, [load, cancel]);

  const page = useCallback(
    async (direction: 'before' | 'after') => {
      const flight = direction === 'before' ? beforeFlight : afterFlight;
      if (flight.current) return flight.current;
      if (!authorized || !userId || !threadId || current.current.scope !== scope) return;
      const cursor =
        direction === 'before' ? current.current.state.previousCursor : current.current.state.nextCursor;
      if (!cursor) return;
      const gen = generation.current;
      const controller = new AbortController();
      controllers.current.add(controller);
      const setLoading = direction === 'before' ? setLoadingBefore : setLoadingAfter;
      setLoading(true);
      const run = (async () => {
        try {
          const incoming = await fetchHistoryWindow(threadId, {
            [direction]: cursor,
            signal: controller.signal,
          });
          if (gen !== generation.current || controller.signal.aborted) return;
          setEntry((previous) => {
            if (previous.scope !== scope) return previous;
            const state = mergeHistoryWindow(
              previous.state,
              incoming,
              direction === 'before' ? 'prepend' : 'append',
            );
            cache?.put(userId, threadId, state);
            return { scope, state };
          });
          setError(null);
          setErrorStatus(null);
        } catch (err) {
          if (gen === generation.current && !controller.signal.aborted) fail(err, current.current.state.mode);
        } finally {
          controllers.current.delete(controller);
          if (gen === generation.current) {
            setLoading(false);
            flight.current = null;
          }
        }
      })();
      flight.current = run;
      return run;
    },
    [authorized, cache, fail, scope, threadId, userId],
  );
  const loadBefore = useCallback(() => page('before'), [page]);
  const loadAfter = useCallback(() => page('after'), [page]);
  const goLatest = useCallback(() => load(true), [load]);
  const retry = useCallback(() => load(), [load]);
  const mergeLive = useCallback(
    (messages: MastraDBMessage[]) => {
      setEntry((previous) =>
        previous.scope === scope ? { scope, state: mergeLiveMessages(previous.state, messages) } : previous,
      );
      if (userId && threadId) cache?.invalidate(userId, threadId);
    },
    [cache, scope, threadId, userId],
  );
  const matches = entry.scope === scope;
  return {
    state: matches ? entry.state : emptyHistoryState(targetMessageId ? 'around' : 'latest'),
    status: matches ? status : 'loading',
    validating: matches && validating,
    authorized: matches && authorized,
    loadingBefore: matches && loadingBefore,
    loadingAfter: matches && loadingAfter,
    error: matches ? error : null,
    errorStatus: matches ? errorStatus : null,
    loadBefore,
    loadAfter,
    goLatest,
    retry,
    mergeLive,
  };
}
export { createThreadHistoryCache };
