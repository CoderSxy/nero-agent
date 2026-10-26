import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import * as historyClient from './history-window-client';
import { createThreadHistoryCache } from './thread-history-cache';
import { useThreadHistory } from './use-thread-history';
import type { HistoryWindow } from './history-window-types';

function msg(id: string): MastraDBMessage {
  return {
    id,
    role: 'user',
    createdAt: new Date(`2026-10-01T00:00:${id.padStart(2, '0')}.000Z`),
    content: { format: 2, parts: [{ type: 'text', text: id }] },
  };
}

function windowFor(ids: string[], extra: Partial<HistoryWindow> = {}): HistoryWindow {
  const messages = ids.map(msg);
  return {
    version: 1,
    thread: { id: 'thread-a', resourceId: 'user-a', updatedAt: '2026-10-01T00:00:00.000Z' },
    messages,
    turns: messages.map((message) => ({
      turnId: message.id,
      originMessageId: message.id,
      provisional: false,
      messageIds: [message.id],
      partialBefore: false,
      partialAfter: false,
    })),
    previousCursor: ids.length >= 8 ? 'before-cursor' : null,
    nextCursor: null,
    snapshotUpper: 'upper',
    oversizedMessage: false,
    ...extra,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useThreadHistory', () => {
  it('loads latest once and does not download a 500-message fixture entirely', async () => {
    const fetchSpy = vi.spyOn(historyClient, 'fetchHistoryWindow').mockResolvedValue(
      windowFor(Array.from({ length: 16 }, (_, i) => String(i + 1).padStart(2, '0'))),
    );
    const { result } = renderHook(() =>
      useThreadHistory({ userId: 'user-a', threadId: 'thread-a' }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]?.before).toBeUndefined();
    expect(result.current.state.messages.length).toBe(16);
  });

  it('shows cache while validating and ignores stale responses from prior thread', async () => {
    const cache = createThreadHistoryCache();
    cache.put('user-a', 'thread-a', {
      ...windowFor(['01']),
      thread: { id: 'thread-a', resourceId: 'user-a', updatedAt: '2026-10-01T00:00:00.000Z' },
      mode: 'latest',
      gap: false,
      scrollAnchor: null,
      turnAliases: {},
      previousCursor: null,
      nextCursor: null,
      snapshotUpper: 'upper',
      oversizedMessage: false,
      messages: [msg('01')],
      turns: [],
    });

    let resolveB: (value: HistoryWindow) => void = () => undefined;
    const fetchSpy = vi.spyOn(historyClient, 'fetchHistoryWindow').mockImplementation(async (threadId) => {
      if (threadId === 'thread-a') {
        return new Promise(() => undefined);
      }
      return new Promise((resolve) => {
        resolveB = resolve;
      });
    });

    const { result, rerender } = renderHook(
      ({ threadId }) => useThreadHistory({ userId: 'user-a', threadId, cache }),
      { initialProps: { threadId: 'thread-a' } },
    );
    expect(result.current.state.messages.map((message) => message.id)).toEqual(['01']);
    expect(result.current.validating).toBe(true);

    rerender({ threadId: 'thread-b' });
    await act(async () => {
      resolveB(windowFor(['99']));
    });
    await waitFor(() => expect(result.current.state.messages.map((m) => m.id)).toEqual(['99']));
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('dedupes concurrent loadBefore and swallows abort errors', async () => {
    const fetchSpy = vi.spyOn(historyClient, 'fetchHistoryWindow')
      .mockResolvedValueOnce(windowFor(['08', '09'], { previousCursor: 'p1' }))
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return windowFor(['06', '07'], { previousCursor: null, nextCursor: 'n1' });
      });

    const { result } = renderHook(() =>
      useThreadHistory({ userId: 'user-a', threadId: 'thread-a' }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      const first = result.current.loadBefore();
      const second = result.current.loadBefore();
      await Promise.all([first, second]);
    });
    expect(fetchSpy.mock.calls.filter((call) => call[1]?.before === 'p1')).toHaveLength(1);
  });
});

it('treats cached 401/403/404 revalidation as terminal and clears the display', async () => {
  for(const status of [401,403,404]) {
    const cache=createThreadHistoryCache();
    cache.put('user-a','thread-a',{...windowFor(['01']),mode:'latest',gap:false,scrollAnchor:null,turnAliases:{}} as any);
    vi.spyOn(historyClient,'fetchHistoryWindow').mockRejectedValue(new historyClient.HistoryWindowError(status,'Access denied'));
    const {result,unmount}=renderHook(()=>useThreadHistory({userId:'user-a',threadId:'thread-a',cache}));
    await waitFor(()=>expect(result.current.validating).toBe(false));
    expect(result.current.status).toBe('error');
    expect(result.current.state.messages).toEqual([]);
    expect(cache.get('user-a','thread-a')).toBeNull();
    unmount();
  }
});

it('keeps an existing conversation mounted while refreshing latest', async () => {
  let resolve!:(page:HistoryWindow)=>void;
  vi.spyOn(historyClient,'fetchHistoryWindow').mockResolvedValueOnce(windowFor(['01'])).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const {result}=renderHook(()=>useThreadHistory({userId:'user-a',threadId:'thread-a'}));
  await waitFor(()=>expect(result.current.authorized).toBe(true));
  let promise!:Promise<void>;
  act(()=>{promise=result.current.goLatest();});
  expect(result.current.status).toBe('ready');
  expect(result.current.state.messages[0]?.id).toBe('01');
  await act(async()=>{resolve(windowFor(['02']));await promise;});
});
