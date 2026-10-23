import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { AuthContext } from '../../auth/auth-context';

declare const workspaceMutationTokenBrand: unique symbol;

export type WorkspaceMutationToken = {
  readonly [workspaceMutationTokenBrand]: true;
  readonly userId: string;
  readonly expiresAt: number;
};

const liveTokens = new WeakSet<object>();

type HeldLease = {
  token: WorkspaceMutationToken;
  userId: string;
};

export type MutationLockAdapter = {
  acquire(userId: string, signal?: AbortSignal): Promise<() => Promise<void>>;
};

const DEFAULT_TOKEN_TTL_MS = 30 * 60 * 1000;

function mintToken(userId: string, ttlMs = DEFAULT_TOKEN_TTL_MS): WorkspaceMutationToken {
  const token = {
    userId,
    expiresAt: Date.now() + ttlMs,
  } as WorkspaceMutationToken;
  liveTokens.add(token);
  return token;
}

export function isWorkspaceMutationToken(value: unknown): value is WorkspaceMutationToken {
  return typeof value === 'object'
    && value !== null
    && liveTokens.has(value)
    && typeof (value as WorkspaceMutationToken).userId === 'string'
    && typeof (value as WorkspaceMutationToken).expiresAt === 'number';
}

function assertUsableToken(token: WorkspaceMutationToken, userId: string): void {
  if (!isWorkspaceMutationToken(token)) {
    throw new Error('Invalid workspace mutation token');
  }
  if (token.userId !== userId) {
    throw new Error('Workspace mutation token owner mismatch');
  }
  if (Date.now() > token.expiresAt) {
    throw new Error('Workspace mutation token expired');
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = signal.reason instanceof Error
      ? signal.reason
      : new Error('Workspace mutation cancelled', { cause: signal.reason });
    error.name = error.name === 'Error' ? 'AbortError' : error.name;
    throw error;
  }
}

/** In-process per-user mutex. Not cross-process. */
export function createInMemoryMutationAdapter(): MutationLockAdapter {
  const tails = new Map<string, Promise<void>>();
  return {
    async acquire(userId, signal) {
      throwIfAborted(signal);
      const previous = tails.get(userId) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const next = previous.then(() => gate);
      tails.set(userId, next.then(() => undefined, () => undefined));

      let abortHandler: (() => void) | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const onAbort = () => {
            if (settled) return;
            settled = true;
            release();
            const error = new Error('Workspace mutation cancelled');
            error.name = 'AbortError';
            reject(error);
          };
          abortHandler = onAbort;
          signal?.addEventListener('abort', onAbort, { once: true });
          previous.then(() => {
            if (settled) return;
            if (signal?.aborted) {
              onAbort();
              return;
            }
            settled = true;
            resolve();
          }, reject);
        });
      } finally {
        if (abortHandler) signal?.removeEventListener('abort', abortHandler);
      }

      return async () => {
        release();
      };
    },
  };
}

function advisoryKey(userId: string): string {
  return createHash('sha256')
    .update(`nero-agent.workspace-mutation.v1:${userId}`)
    .digest('hex')
    .slice(0, 32);
}

/** Return a late connection to the pool if acquisition was cancelled while queued. */
async function connectWithSignal(pool: Pool, signal: AbortSignal): Promise<PoolClient> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('Workspace lock acquisition cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    pool.connect().then(client => {
      signal.removeEventListener('abort', abort);
      if (settled) { client.release(); return; }
      settled = true;
      resolve(client);
    }, error => {
      signal.removeEventListener('abort', abort);
      if (!settled) { settled = true; reject(error); }
    });
    if (signal.aborted) abort();
  });
}

async function waitForRetry(signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 25);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Waiters never retain a connection while waiting on another owner's lock. */
export function createPgMutationAdapter(pool: Pool): MutationLockAdapter {
  return {
    async acquire(userId, signal) {
      const waiting = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
      const key = advisoryKey(userId);
      for (;;) {
        const client = await connectWithSignal(pool, waiting);
        let locked = false;
        try {
          throwIfAborted(waiting);
          const result = await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key],
          );
          locked = result.rows[0]?.locked === true;
        } catch (error) {
          client.release(error instanceof Error ? error : new Error('lock acquire failed'));
          throw error;
        }
        if (locked) {
          return async () => {
            let releaseError: Error | undefined;
            try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); }
            catch (error) { releaseError = error instanceof Error ? error : new Error('unlock failed'); }
            finally { client.release(releaseError); }
          };
        }
        client.release();
        await waitForRetry(waiting);
      }
    },
  };
}

const defaultAdapter = createInMemoryMutationAdapter();

let databaseAdapter: MutationLockAdapter | undefined;

/** Lock holders use a separate bounded pool, leaving app queries/quotas free to proceed. */
export function workspaceMutationAdapter(): MutationLockAdapter {
  if (!process.env.DATABASE_URL) return defaultAdapter;
  databaseAdapter ??= createPgMutationAdapter(new Pool({
    connectionString: process.env.DATABASE_URL, max: 10,
    connectionTimeoutMillis: 10_000, query_timeout: 10_000, allowExitOnIdle: true,
  }));
  return databaseAdapter;
}

export type WithWorkspaceMutationOptions = {
  signal?: AbortSignal;
  token?: WorkspaceMutationToken;
  adapter?: MutationLockAdapter;
  tokenTtlMs?: number;
};

/**
 * Serialize all in-app workspace writes for one user.
 * Pass an existing private token to reenter without re-acquiring.
 */
export async function withWorkspaceMutation<T>(
  auth: AuthContext,
  work: (token: WorkspaceMutationToken) => Promise<T>,
  options: WithWorkspaceMutationOptions = {},
): Promise<T> {
  const userId = auth.userId;
  if (options.token) {
    assertUsableToken(options.token, userId);
    return work(options.token);
  }

  const adapter = options.adapter ?? defaultAdapter;
  throwIfAborted(options.signal);
  const release = await adapter.acquire(userId, options.signal);
  const token = mintToken(userId, options.tokenTtlMs);
  try {
    return await work(token);
  } finally {
    liveTokens.delete(token);
    await release();
  }
}

/** @internal test helper */
export function __testing(): { liveTokens: WeakSet<object> } {
  return { liveTokens };
}

// Silence unused HeldLease until collector wiring — keep type exported for docs.
export type { HeldLease };
