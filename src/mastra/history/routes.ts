import { registerApiRoute, type ApiRoute } from '@mastra/core/server';
import type { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import { trustedAuth } from '../auth/auth-context';
import { getPool } from '../auth/db';
import { assertThreadOwned, ThreadGuardError, type ThreadLookup } from '../auth/thread-guard';
import { createHistoryRepository, type HistoryRepository } from './repository';
import { HistoryServiceError, loadHistoryWindow } from './service';

export type HistoryRouteDeps = {
  lookup?: ThreadLookup;
  repositoryFactory?: () => HistoryRepository;
};

async function threadLookupFor(
  c: { get(key: string): unknown },
  lookup?: ThreadLookup,
): Promise<ThreadLookup> {
  if (lookup) return lookup;
  const mastra = c.get('mastra') as Mastra | undefined;
  const requestContext = c.get('requestContext') as RequestContext | undefined;
  if (!mastra || !requestContext) throw new Error('Authentication is required');
  const memory = await mastra.getAgent('agent').getMemory({ requestContext });
  if (!memory) throw new Error('Agent memory is unavailable');
  return memory as ThreadLookup;
}

function defaultRepository(): HistoryRepository {
  return createHistoryRepository(getPool());
}

function statusOf(error: unknown): number | null {
  if (error instanceof HistoryServiceError) return error.status;
  if (error instanceof ThreadGuardError) return error.status;
  if (error && typeof error === 'object' && 'status' in error) {
    const status = Number((error as { status: number }).status);
    if (status >= 400 && status < 600) return status;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('cursor') || message.includes('mutually exclusive')) return 400;
    if (message.includes('unauthenticated') || message.includes('authentication')) return 401;
  }
  return null;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof HistoryServiceError || error instanceof ThreadGuardError) return error.message;
  if (error instanceof Error) {
    const message = error.message;
    if (/select |insert |update |delete |from |sql/i.test(message)) return fallback;
    if (message.length > 200) return fallback;
    return message;
  }
  return fallback;
}

export function createHistoryRoutes(deps: HistoryRouteDeps = {}): ApiRoute[] {
  const repositoryFactory = deps.repositoryFactory ?? defaultRepository;

  return [
    registerApiRoute('/agent-history/threads/:threadId/window', {
      method: 'GET',
      handler: async (c) => {
        try {
          const requestContext = c.get('requestContext') as RequestContext;
          const auth = trustedAuth(requestContext);
          const threadId = c.req.param('threadId')?.trim();
          if (!threadId) return c.json({ error: 'threadId is required' }, 400);

          // Client-supplied userId/resourceId must never expand authority.
          const forgedUser = c.req.query('userId') || c.req.query('resourceId');
          void forgedUser;

          const threadLookup = await threadLookupFor(c, deps.lookup);
          const owned = await assertThreadOwned(auth, threadId, threadLookup);

          const before = c.req.query('before') || undefined;
          const after = c.req.query('after') || undefined;
          const around = c.req.query('around') || undefined;
          const present = [before, after, around].filter(Boolean);
          if (present.length > 1) {
            return c.json({ error: 'before, after, and around are mutually exclusive' }, 400);
          }

          const repo = repositoryFactory();
          const body = await loadHistoryWindow(
            repo,
            { userId: owned.resourceId, threadId: owned.id },
            { before, after, around },
          );

          c.header('Cache-Control', 'no-store');
          return c.json(body);
        } catch (error) {
          const status = statusOf(error);
          if (status) {
            return c.json({ error: safeErrorMessage(error, 'Request failed') }, status as 400);
          }
          console.error('agent-history window failed', error instanceof Error ? error.message : 'unknown');
          return c.json({ error: 'Failed to load history window' }, 500);
        }
      },
    }),
  ];
}

export const historyRoutes = createHistoryRoutes();
