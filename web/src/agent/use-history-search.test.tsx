import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { createHistorySearchCache } from './history-search-cache';
import type { HistorySearchDocument } from './history-search-index';
import { RECENT_HISTORY_LIMIT } from './history-search-index';
import type { Thread } from './thread-scope';
import { useHistorySearch } from './use-history-search';

const loadThread = vi.fn();

function textMessage(id: string, role: 'user' | 'assistant', text: string): MastraDBMessage {
  return {
    id,
    role,
    createdAt: new Date('2026-10-06T01:00:00Z'),
    content: { format: 2, parts: [{ type: 'text', text }] },
  };
}

function makeThreads(count: number, userId = 'user-1', idPrefix = 'thread'): Thread[] {
  return Array.from({ length: count }, (_, index) => {
    const seq = count - 1 - index;
    return {
      id: `${idPrefix}-${String(seq).padStart(2, '0')}`,
      title: `会话 ${seq}`,
      updatedAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
      resourceId: userId,
      metadata: {},
    } as Thread;
  });
}

function threadLoadResult(thread: Thread, question = '问题', answer = '回答') {
  return {
    thread,
    messages: [
      textMessage('u1', 'user', question),
      textMessage('a1', 'assistant', answer),
    ],
  };
}

function docForThread(thread: Thread, question = '问题'): HistorySearchDocument {
  return {
    threadId: thread.id,
    threadTitle: thread.title ?? '',
    threadUpdatedAt: new Date(thread.updatedAt).toISOString(),
    userMessageId: 'u1',
    questionText: question,
    answerText: '回答',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadThread.mockImplementation(async (threadId: string, userId: string) => {
    const thread = makeThreads(100, userId).find(t => t.id === threadId);
    if (!thread) throw new Error('missing');
    return threadLoadResult(thread, `q-${threadId}`, `a-${threadId}`);
  });
});

describe('useHistorySearch', () => {
  it('loads conversations that arrive after search was opened during the initial list fetch', async () => {
    const cache = createHistorySearchCache();
    const threads = makeThreads(2);
    const { result, rerender } = renderHook(
      ({ list }) => useHistorySearch({ userId: 'user-1', threads: list, cache, loadThread }),
      { initialProps: { list: [] as Thread[] } },
    );

    act(() => result.current.ensureRecent());
    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    rerender({ list: threads });

    await waitFor(() => expect(result.current.documents).toHaveLength(2));
    expect(result.current.documents.map(document => document.threadId)).toEqual(threads.map(thread => thread.id));
  });

  it('refreshes an indexed conversation when its updatedAt changes', async () => {
    const cache = createHistorySearchCache();
    const thread = makeThreads(1)[0];
    const { result, rerender } = renderHook(
      ({ list }) => useHistorySearch({ userId: 'user-1', threads: list, cache, loadThread }),
      { initialProps: { list: [thread] } },
    );

    act(() => result.current.ensureRecent());
    await waitFor(() => expect(result.current.documents[0]?.questionText).toBe('q-thread-00'));
    const updated = { ...thread, updatedAt: '2026-10-12T00:00:00.000Z' } as Thread;
    loadThread.mockResolvedValue(threadLoadResult(updated, '其他标签页的新问题'));
    rerender({ list: [updated] });

    await waitFor(() => expect(result.current.documents[0]?.questionText).toBe('其他标签页的新问题'));
  });

  it('keeps the all-history scope current when an older conversation changes', async () => {
    const cache = createHistorySearchCache();
    const threads = makeThreads(51);
    loadThread.mockImplementation(async (threadId: string) =>
      threadLoadResult(threads.find(thread => thread.id === threadId)!, `q-${threadId}`));
    const { result, rerender } = renderHook(
      ({ list }) => useHistorySearch({ userId: 'user-1', threads: list, cache, loadThread }),
      { initialProps: { list: threads } },
    );

    act(() => result.current.ensureRecent());
    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    act(() => result.current.loadAll());
    await waitFor(() => expect(result.current.scope).toBe('all'));

    const older = { ...threads[50], updatedAt: '2026-10-12T00:00:00.000Z' } as Thread;
    loadThread.mockImplementation(async (threadId: string) =>
      threadLoadResult(threadId === older.id ? older : threads.find(thread => thread.id === threadId)!,
        threadId === older.id ? '旧会话的新问题' : `q-${threadId}`));
    rerender({ list: [...threads.slice(0, 50), older] });

    await waitFor(() => expect(result.current.scope).toBe('all'));
    await waitFor(() => expect(result.current.documents.find(doc => doc.threadId === older.id)?.questionText)
      .toBe('旧会话的新问题'));
  });

  it('loads the newest 50 threads with bounded concurrency, then loadAll fetches only the rest', async () => {
    const threads = makeThreads(55);
    let active = 0;
    let maxActive = 0;
    loadThread.mockImplementation(async (threadId: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      const thread = threads.find(t => t.id === threadId);
      if (!thread) throw new Error('missing');
      return threadLoadResult(thread);
    });

    const cache = createHistorySearchCache();
    const { result } = renderHook(() => useHistorySearch({ userId: 'user-1', threads, cache, loadThread }));

    act(() => result.current.ensureRecent());

    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    expect(loadThread).toHaveBeenCalledTimes(RECENT_HISTORY_LIMIT);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(result.current.recentProgress).toEqual({ completed: RECENT_HISTORY_LIMIT, total: RECENT_HISTORY_LIMIT });
    expect(result.current.scope).toBe('recent');
    expect(result.current.documents.length).toBe(RECENT_HISTORY_LIMIT);

    const recentIds = new Set(threads.slice(0, RECENT_HISTORY_LIMIT).map(t => t.id));
    for (const doc of result.current.documents) {
      expect(recentIds.has(doc.threadId)).toBe(true);
    }

    act(() => result.current.loadAll());

    await waitFor(() => expect(result.current.fullStatus).toBe('ready'));
    expect(loadThread).toHaveBeenCalledTimes(55);
    expect(result.current.fullProgress).toEqual({ completed: 5, total: 5 });
    expect(result.current.scope).toBe('all');
    expect(result.current.documents.length).toBe(55);
  });

  it('uses cache hits and skips network fetch for warm threads', async () => {
    const threads = makeThreads(3);
    const cache = createHistorySearchCache();
    for (const thread of threads) {
      await cache.put(
        'user-1',
        thread.id,
        new Date(thread.updatedAt).toISOString(),
        [docForThread(thread)],
      );
    }

    const { result } = renderHook(() => useHistorySearch({ userId: 'user-1', threads, cache, loadThread }));
    act(() => result.current.ensureRecent());

    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    expect(loadThread).not.toHaveBeenCalled();
    expect(result.current.documents).toHaveLength(3);
  });

  it('tracks recent failures, retries only failed ids, and does not cache empty documents', async () => {
    const threads = makeThreads(3);
    loadThread.mockImplementation(async (threadId: string) => {
      if (threadId === threads[1].id) throw new Error('network');
      const thread = threads.find(t => t.id === threadId)!;
      return threadLoadResult(thread);
    });

    const cache = createHistorySearchCache();
    const { result } = renderHook(() => useHistorySearch({ userId: 'user-1', threads, cache, loadThread }));

    act(() => result.current.ensureRecent());
    await waitFor(() => expect(result.current.recentStatus).toBe('error'));
    expect(result.current.recentFailedCount).toBe(1);
    expect(result.current.documents).toHaveLength(2);
    expect(await cache.get('user-1', threads[1].id, new Date(threads[1].updatedAt).toISOString())).toBeNull();

    loadThread.mockImplementation(async (threadId: string) => {
      const thread = threads.find(t => t.id === threadId)!;
      return threadLoadResult(thread, 'fixed');
    });
    act(() => result.current.retryRecent());
    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    expect(loadThread).toHaveBeenCalledTimes(4);
    expect(result.current.documents.some(d => d.threadId === threads[1].id && d.questionText === 'fixed')).toBe(true);
  });

  it('keeps recent documents when full load fails and retries full failures only', async () => {
    const threads = makeThreads(52);
    loadThread.mockImplementation(async (threadId: string) => {
      if (threadId === threads[50].id || threadId === threads[51].id) throw new Error('full-fail');
      const thread = threads.find(t => t.id === threadId)!;
      return threadLoadResult(thread);
    });

    const cache = createHistorySearchCache();
    const { result } = renderHook(() => useHistorySearch({ userId: 'user-1', threads, cache, loadThread }));

    act(() => result.current.ensureRecent());
    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    const recentDocCount = result.current.documents.length;

    act(() => result.current.loadAll());
    await waitFor(() => expect(result.current.fullStatus).toBe('error'));
    expect(result.current.fullFailedCount).toBe(2);
    expect(result.current.documents.length).toBe(recentDocCount);
    expect(result.current.scope).toBe('recent');

    loadThread.mockImplementation(async (threadId: string) => {
      const thread = threads.find(t => t.id === threadId)!;
      return threadLoadResult(thread);
    });
    act(() => result.current.retryFull());
    await waitFor(() => expect(result.current.fullStatus).toBe('ready'));
    expect(result.current.scope).toBe('all');
    expect(result.current.documents.length).toBe(52);
  });

  it('allows search during full load after recent is ready', async () => {
    const threads = makeThreads(55);
    let releaseFull: (() => void) | undefined;
    const fullGate = new Promise<void>(resolve => {
      releaseFull = resolve;
    });

    loadThread.mockImplementation(async (threadId: string) => {
      const thread = threads.find(t => t.id === threadId)!;
      if (!threads.slice(0, RECENT_HISTORY_LIMIT).some(t => t.id === threadId)) {
        await fullGate;
      }
      return threadLoadResult(thread);
    });

    const cache = createHistorySearchCache();
    const { result } = renderHook(() => useHistorySearch({ userId: 'user-1', threads, cache, loadThread }));

    act(() => result.current.ensureRecent());
    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    expect(result.current.documents.length).toBe(RECENT_HISTORY_LIMIT);

    act(() => result.current.loadAll());
    await waitFor(() => expect(result.current.fullStatus).toBe('loading'));
    expect(result.current.documents.length).toBe(RECENT_HISTORY_LIMIT);

    releaseFull?.();
    await waitFor(() => expect(result.current.fullStatus).toBe('ready'));
  });

  it('ignores stale results after cancelRecent and after unmount', async () => {
    const threads = makeThreads(10);
    let resolveLoads: (() => void) | undefined;
    const block = new Promise<void>(resolve => {
      resolveLoads = resolve;
    });

    loadThread.mockImplementation(async (threadId: string) => {
      await block;
      const thread = threads.find(t => t.id === threadId)!;
      return threadLoadResult(thread);
    });

    const cache = createHistorySearchCache();
    const { result, unmount } = renderHook(() => useHistorySearch({ userId: 'user-1', threads, cache, loadThread }));

    act(() => result.current.ensureRecent());
    expect(result.current.recentStatus).toBe('loading');

    act(() => result.current.cancelRecent());
    resolveLoads?.();
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(result.current.documents).toHaveLength(0);
    expect(result.current.recentStatus).toBe('idle');

    const hook2 = renderHook(() => useHistorySearch({ userId: 'user-1', threads, cache, loadThread }));
    act(() => hook2.result.current.ensureRecent());
    hook2.unmount();
    resolveLoads?.();
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(hook2.result.current.documents).toHaveLength(0);
  });

  it('does not apply in-flight loads from previous user after account switch', async () => {
    const threadsA = makeThreads(2, 'user-a', 'user-a-thread');
    const threadsB = makeThreads(2, 'user-b', 'user-b-thread');
    let resolveLoads: (() => void) | undefined;
    const block = new Promise<void>(resolve => {
      resolveLoads = resolve;
    });

    loadThread.mockImplementation(async (threadId: string) => {
      await block;
      const thread = [...threadsA, ...threadsB].find(t => t.id === threadId);
      if (!thread) throw new Error('missing');
      return threadLoadResult(thread);
    });

    const cache = createHistorySearchCache();
    const { result, rerender } = renderHook(
      ({ userId, threads }) => useHistorySearch({ userId, threads, cache, loadThread }),
      { initialProps: { userId: 'user-a', threads: threadsA } },
    );

    act(() => result.current.ensureRecent());
    expect(result.current.recentStatus).toBe('loading');

    rerender({ userId: 'user-b', threads: threadsB });
    expect(result.current.documents).toHaveLength(0);

    resolveLoads?.();
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(result.current.documents.some(d => threadsA.some(t => t.id === d.threadId))).toBe(false);

    act(() => result.current.ensureRecent());
    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    expect(result.current.documents.every(d => threadsB.some(t => t.id === d.threadId))).toBe(true);
  });

  it('discards previous user documents on account switch', async () => {
    const threadsA = makeThreads(2, 'user-a', 'user-a-thread');
    const threadsB = makeThreads(2, 'user-b', 'user-b-thread');
    const cache = createHistorySearchCache();
    loadThread.mockImplementation(async (threadId: string) => {
      const thread = [...threadsA, ...threadsB].find(t => t.id === threadId);
      if (!thread) throw new Error('missing');
      return threadLoadResult(thread);
    });

    const { result, rerender } = renderHook(
      ({ userId, threads }) => useHistorySearch({ userId, threads, cache, loadThread }),
      { initialProps: { userId: 'user-a', threads: threadsA } },
    );

    act(() => result.current.ensureRecent());
    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    expect(result.current.documents.every(d => threadsA.some(t => t.id === d.threadId))).toBe(true);

    rerender({ userId: 'user-b', threads: threadsB });
    expect(result.current.documents).toHaveLength(0);

    act(() => result.current.ensureRecent());
    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    expect(result.current.documents.every(d => threadsB.some(t => t.id === d.threadId))).toBe(true);
    expect(result.current.documents.some(d => threadsA.some(t => t.id === d.threadId))).toBe(false);
  });

  it('removes deleted threads from documents and cache cleanup', async () => {
    const threads = makeThreads(3);
    const cache = createHistorySearchCache();
    const removeMissing = vi.spyOn(cache, 'removeMissing');

    const { result, rerender } = renderHook(
      ({ list }) => useHistorySearch({ userId: 'user-1', threads: list, cache, loadThread }),
      { initialProps: { list: threads } },
    );

    act(() => result.current.ensureRecent());
    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    expect(result.current.documents).toHaveLength(3);

    const trimmed = threads.filter(t => t.id !== threads[1].id);
    rerender({ list: trimmed });
    await waitFor(() => expect(removeMissing).toHaveBeenCalled());
    expect(result.current.documents.some(d => d.threadId === threads[1].id)).toBe(false);
    expect(result.current.documents).toHaveLength(2);
  });

  it('invalidateThread refreshes content even when updatedAt is unchanged', async () => {
    const threads = makeThreads(1);
    const cache = createHistorySearchCache();
    const { result } = renderHook(() => useHistorySearch({ userId: 'user-1', threads, cache, loadThread }));

    act(() => result.current.ensureRecent());
    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    expect(result.current.documents[0]?.questionText).toBe('q-thread-00');

    loadThread.mockImplementation(async () => threadLoadResult(threads[0], '刷新后问题'));
    await act(async () => {
      await result.current.invalidateThread(threads[0].id);
    });

    expect(result.current.documents[0]?.questionText).toBe('刷新后问题');
    const updatedAt = new Date(threads[0].updatedAt).toISOString();
    expect(await cache.get('user-1', threads[0].id, updatedAt)).not.toBeNull();
  });

  it('does not call removeMissing when thread list is initially empty', async () => {
    const threads: Thread[] = [];
    const cache = createHistorySearchCache();
    const removeMissing = vi.spyOn(cache, 'removeMissing');
    const { unmount } = renderHook(() => useHistorySearch({ userId: 'user-1', threads, cache, loadThread }));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(removeMissing).not.toHaveBeenCalled();
    unmount();
  });

  it('cancelRecent clears fullStatus back to idle', async () => {
    const threads = makeThreads(3);
    const cache = createHistorySearchCache();
    const { result, unmount } = renderHook(() => useHistorySearch({ userId: 'user-1', threads, cache, loadThread }));
    act(() => result.current.ensureRecent());
    await waitFor(() => expect(result.current.recentStatus).toBe('ready'));
    act(() => result.current.cancelRecent());
    expect(result.current.recentStatus).toBe('idle');
    expect(result.current.fullStatus).toBe('idle');
    expect(result.current.documents).toHaveLength(0);
    unmount();
  });
});
