import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyHistoryState } from './history-window-types';
import { createThreadHistoryCache, isCacheFresh } from './thread-history-cache';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';

function bigState(chars: number) {
  const state = emptyHistoryState();
  state.messages = [{
    id: 'big',
    role: 'user',
    createdAt: new Date(),
    content: { format: 2, parts: [{ type: 'text', text: 'x'.repeat(chars) }] },
  } as MastraDBMessage];
  return state;
}

describe('thread-history-cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires after 30s and evicts by LRU and byte budget', () => {
    const cache = createThreadHistoryCache({ maxThreads: 5, maxBytes: 10_485_760 });
    const state = emptyHistoryState();
    cache.put('u', 't1', state);
    const entry = cache.get('u', 't1');
    expect(entry).toBeTruthy();
    expect(isCacheFresh(entry!)).toBe(true);
    vi.advanceTimersByTime(30_001);
    expect(isCacheFresh(cache.get('u', 't1')!)).toBe(false);

    for (let i = 0; i < 6; i++) cache.put('u', `t${i}`, emptyHistoryState());
    expect(cache.size()).toBe(5);
    expect(cache.get('u', 't0')).toBeNull();

    const tiny = createThreadHistoryCache({ maxThreads: 5, maxBytes: 1000 });
    tiny.put('u', 'huge', bigState(50_000));
    expect(tiny.size()).toBe(0);
  });

  it('clears on delete, logout, and user switch', () => {
    const cache = createThreadHistoryCache();
    cache.put('a', 't1', emptyHistoryState());
    cache.put('b', 't1', emptyHistoryState());
    cache.delete('a', 't1');
    expect(cache.get('a', 't1')).toBeNull();
    cache.clear('b');
    expect(cache.get('b', 't1')).toBeNull();
    cache.put('a', 't2', emptyHistoryState());
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
