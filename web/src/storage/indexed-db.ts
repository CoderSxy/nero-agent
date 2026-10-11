export const APP_DB_NAME = 'nero-agent-client';
export const APP_DB_VERSION = 1;

export const APP_DB_STORES = {
  historySearchDocuments: 'historySearchDocuments',
} as const;

let openPromise: Promise<IDBDatabase> | null = null;

function attachVersionChangeHandler(db: IDBDatabase): void {
  db.onversionchange = () => {
    db.close();
    openPromise = null;
  };
}

function openDatabaseRequest(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      openPromise = null;
      reject(new Error('IndexedDB is not available'));
      return;
    }

    const request = indexedDB.open(APP_DB_NAME, APP_DB_VERSION);

    request.onerror = () => {
      openPromise = null;
      reject(request.error ?? new Error('Failed to open IndexedDB'));
    };

    request.onblocked = () => {
      openPromise = null;
      reject(new Error('IndexedDB open blocked'));
    };

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(APP_DB_STORES.historySearchDocuments)) {
        db.createObjectStore(APP_DB_STORES.historySearchDocuments, {
          keyPath: ['userId', 'threadId'],
        });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      attachVersionChangeHandler(db);
      resolve(db);
    };
  });
}

export function openAppDatabase(): Promise<IDBDatabase> {
  if (!openPromise) {
    openPromise = openDatabaseRequest();
  }
  return openPromise;
}

/** Clears the in-memory connection handle (tests and recovery after external close). */
export async function resetAppDatabaseConnection(): Promise<void> {
  if (!openPromise) return;
  try {
    const db = await openPromise;
    db.onversionchange = null;
    db.close();
  } catch {
    // ignore close errors during reset
  } finally {
    openPromise = null;
  }
}
