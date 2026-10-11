import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistorySearchDocument } from './history-search-index';
import { createHistorySearchCache } from './history-search-cache';
import { APP_DB_NAME, resetAppDatabaseConnection } from '../storage/indexed-db';

const sampleDoc = (threadId: string): HistorySearchDocument => ({
  threadId,
  threadTitle: 'Title',
  threadUpdatedAt: '2026-10-11T12:00:00.000Z',
  userMessageId: 'msg-1',
  questionText: 'question',
  answerText: 'answer',
});

describe('createHistorySearchCache', () => {
  beforeEach(async () => {
    await resetAppDatabaseConnection();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(APP_DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  afterEach(async () => {
    await resetAppDatabaseConnection();
    vi.unstubAllGlobals();
  });

  it('returns cached documents on same user, thread, and updatedAt', async () => {
    const cache = createHistorySearchCache();
    const docs = [sampleDoc('t1')];
    await cache.put('user-a', 't1', '2026-10-11T12:00:00.000Z', docs);
    const hit = await cache.get('user-a', 't1', '2026-10-11T12:00:00.000Z');
    expect(hit).toEqual(docs);
  });

  it('misses when thread updatedAt version changed', async () => {
    const cache = createHistorySearchCache();
    await cache.put('user-a', 't1', '2026-10-11T12:00:00.000Z', [sampleDoc('t1')]);
    const miss = await cache.get('user-a', 't1', '2026-10-11T13:00:00.000Z');
    expect(miss).toBeNull();
  });

  it('does not leak entries across users', async () => {
    const cache = createHistorySearchCache();
    await cache.put('user-a', 't1', 'v1', [sampleDoc('t1')]);
    expect(await cache.get('user-b', 't1', 'v1')).toBeNull();
  });

  it('removeMissing deletes stale threads for the user only', async () => {
    const cache = createHistorySearchCache();
    await cache.put('user-a', 'keep', 'v1', [sampleDoc('keep')]);
    await cache.put('user-a', 'drop', 'v1', [sampleDoc('drop')]);
    await cache.put('user-b', 'other', 'v1', [sampleDoc('other')]);
    await cache.removeMissing('user-a', new Set(['keep']));
    expect(await cache.get('user-a', 'keep', 'v1')).not.toBeNull();
    expect(await cache.get('user-a', 'drop', 'v1')).toBeNull();
    expect(await cache.get('user-b', 'other', 'v1')).not.toBeNull();
  });

  it('invalidate removes a single thread for the user', async () => {
    const cache = createHistorySearchCache();
    await cache.put('user-a', 't1', 'v1', [sampleDoc('t1')]);
    await cache.put('user-a', 't2', 'v1', [sampleDoc('t2')]);
    await cache.invalidate('user-a', 't1');
    expect(await cache.get('user-a', 't1', 'v1')).toBeNull();
    expect(await cache.get('user-a', 't2', 'v1')).not.toBeNull();
  });

  it('uses memory fallback when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const cache = createHistorySearchCache();
    const docs = [sampleDoc('mem')];
    await cache.put('user-a', 'mem', 'v1', docs);
    expect(await cache.get('user-a', 'mem', 'v1')).toEqual(docs);
  });

  it('uses memory fallback when database open is blocked', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      const req = { onerror: null as (() => void) | null } as IDBOpenDBRequest;
      Object.defineProperty(req, 'onblocked', {
        set(fn: () => void) {
          queueMicrotask(() => fn());
        },
        configurable: true,
      });
      return req;
    });
    const cache = createHistorySearchCache();
    const docs = [sampleDoc('blocked')];
    await cache.put('user-a', 'blocked', 'v1', docs);
    expect(await cache.get('user-a', 'blocked', 'v1')).toEqual(docs);
  });

  it('get returns null on miss without inventing empty documents', async () => {
    const cache = createHistorySearchCache();
    expect(await cache.get('user-a', 'missing', 'v1')).toBeNull();
  });
});
