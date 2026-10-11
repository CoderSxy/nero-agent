import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_DB_NAME,
  APP_DB_STORES,
  APP_DB_VERSION,
  openAppDatabase,
  resetAppDatabaseConnection,
} from './indexed-db';

describe('openAppDatabase', () => {
  beforeEach(async () => {
    await resetAppDatabaseConnection();
    indexedDB.deleteDatabase(APP_DB_NAME);
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(APP_DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  });

  afterEach(async () => {
    await resetAppDatabaseConnection();
  });

  it('deduplicates concurrent opens into a single indexedDB.open call', async () => {
    const openSpy = vi.spyOn(indexedDB, 'open');
    const [a, b, c] = await Promise.all([
      openAppDatabase(),
      openAppDatabase(),
      openAppDatabase(),
    ]);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(APP_DB_NAME, APP_DB_VERSION);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.objectStoreNames.contains(APP_DB_STORES.historySearchDocuments)).toBe(true);
    openSpy.mockRestore();
  });

  it('closes the shared connection on versionchange', async () => {
    const db = await openAppDatabase();
    const closeSpy = vi.spyOn(db, 'close');
    const handler = db.onversionchange;
    expect(handler).toBeTypeOf('function');
    handler?.call(db, new Event('versionchange') as IDBVersionChangeEvent);
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it('retains existing records when reopening an already valid version-1 database', async () => {
    const db1 = await openAppDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db1.transaction(APP_DB_STORES.historySearchDocuments, 'readwrite');
      tx.objectStore(APP_DB_STORES.historySearchDocuments).put({
        userId: 'u1',
        threadId: 't1',
        updatedAt: '2026-10-11T00:00:00.000Z',
        documents: [],
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db1.close();
    await resetAppDatabaseConnection();

    const db2 = await openAppDatabase();
    const record = await new Promise<unknown>((resolve, reject) => {
      const tx = db2.transaction(APP_DB_STORES.historySearchDocuments, 'readonly');
      const req = tx.objectStore(APP_DB_STORES.historySearchDocuments).get(['u1', 't1']);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(record).toMatchObject({ userId: 'u1', threadId: 't1' });
  });
});
