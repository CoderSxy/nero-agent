import type { HistorySearchDocument } from './history-search-index';
import { APP_DB_STORES, openAppDatabase } from '../storage/indexed-db';

type CacheRecord = {
  userId: string;
  threadId: string;
  updatedAt: string;
  documents: HistorySearchDocument[];
};

type MemoryKey = `${string}\0${string}`;

function memoryKey(userId: string, threadId: string): MemoryKey {
  return `${userId}\0${threadId}`;
}

function idbKeyRangeForUser(userId: string): IDBKeyRange {
  return IDBKeyRange.bound([userId], [userId, '\uffff']);
}

export type HistorySearchCache = {
  get(
    userId: string,
    threadId: string,
    updatedAt: string,
  ): Promise<HistorySearchDocument[] | null>;
  put(
    userId: string,
    threadId: string,
    updatedAt: string,
    documents: HistorySearchDocument[],
  ): Promise<void>;
  removeMissing(userId: string, visibleThreadIds: Set<string>): Promise<void>;
  invalidate(userId: string, threadId: string): Promise<void>;
};

type StorageBackend = {
  getRecord(userId: string, threadId: string): Promise<CacheRecord | null>;
  putRecord(record: CacheRecord): Promise<void>;
  deleteRecord(userId: string, threadId: string): Promise<void>;
  listRecordsForUser(userId: string): Promise<CacheRecord[]>;
};

async function createIndexedDBBackend(): Promise<StorageBackend | null> {
  try {
    await openAppDatabase();
    const storeName = APP_DB_STORES.historySearchDocuments;

    return {
      async getRecord(userId, threadId) {
        const dbConn = await openAppDatabase();
        return await new Promise<CacheRecord | null>((resolve, reject) => {
          const tx = dbConn.transaction(storeName, 'readonly');
          const req = tx.objectStore(storeName).get([userId, threadId]);
          req.onsuccess = () => resolve((req.result as CacheRecord | undefined) ?? null);
          req.onerror = () => reject(req.error);
        });
      },
      async putRecord(record) {
        const dbConn = await openAppDatabase();
        await new Promise<void>((resolve, reject) => {
          const tx = dbConn.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
      async deleteRecord(userId, threadId) {
        const dbConn = await openAppDatabase();
        await new Promise<void>((resolve, reject) => {
          const tx = dbConn.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).delete([userId, threadId]);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
      async listRecordsForUser(userId) {
        const dbConn = await openAppDatabase();
        return await new Promise<CacheRecord[]>((resolve, reject) => {
          const tx = dbConn.transaction(storeName, 'readonly');
          const req = tx.objectStore(storeName).getAll(idbKeyRangeForUser(userId));
          req.onsuccess = () => resolve((req.result as CacheRecord[]) ?? []);
          req.onerror = () => reject(req.error);
        });
      },
    };
  } catch {
    return null;
  }
}

function createMemoryBackend(map: Map<MemoryKey, CacheRecord>): StorageBackend {
  return {
    async getRecord(userId, threadId) {
      return map.get(memoryKey(userId, threadId)) ?? null;
    },
    async putRecord(record) {
      map.set(memoryKey(record.userId, record.threadId), record);
    },
    async deleteRecord(userId, threadId) {
      map.delete(memoryKey(userId, threadId));
    },
    async listRecordsForUser(userId) {
      const prefix = `${userId}\0`;
      return [...map.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, record]) => record);
    },
  };
}

async function resolveBackend(
  memory: Map<MemoryKey, CacheRecord>,
  current: StorageBackend | null | undefined,
): Promise<StorageBackend> {
  if (current) return current;
  const idb = await createIndexedDBBackend();
  if (idb) return idb;
  return createMemoryBackend(memory);
}

export function createHistorySearchCache(): HistorySearchCache {
  const memory = new Map<MemoryKey, CacheRecord>();
  let backend: StorageBackend | null | undefined;

  const storage = async (): Promise<StorageBackend> => {
    backend = await resolveBackend(memory, backend);
    return backend;
  };

  return {
    async get(userId, threadId, updatedAt) {
      const store = await storage();
      const record = await store.getRecord(userId, threadId);
      if (!record || record.updatedAt !== updatedAt) return null;
      return record.documents;
    },

    async put(userId, threadId, updatedAt, documents) {
      const store = await storage();
      await store.putRecord({ userId, threadId, updatedAt, documents });
    },

    async removeMissing(userId, visibleThreadIds) {
      const store = await storage();
      const records = await store.listRecordsForUser(userId);
      for (const record of records) {
        if (!visibleThreadIds.has(record.threadId)) {
          await store.deleteRecord(userId, record.threadId);
        }
      }
    },

    async invalidate(userId, threadId) {
      const store = await storage();
      await store.deleteRecord(userId, threadId);
    },
  };
}
