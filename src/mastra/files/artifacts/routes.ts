import { registerApiRoute, type ApiRoute } from '@mastra/core/server';
import { trustedAuth } from '../../auth/auth-context';
import { assertThreadOwned, type ThreadLookup } from '../../auth/thread-guard';
import type { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import { isUserFilesEnabled } from '../policy';
import {
  ArtifactRepositoryError,
  createArtifactRepository,
} from './repository';

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

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 50;
  if (!/^\d+$/.test(raw)) throw new ArtifactRepositoryError(400, 'limit must be an integer from 1 to 100');
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new ArtifactRepositoryError(400, 'limit must be an integer from 1 to 100');
  }
  return value;
}

export function createTurnArtifactRoutes(lookup?: ThreadLookup): ApiRoute[] {
  return [
    registerApiRoute('/current-workspace/turn-artifacts', {
      method: 'GET',
      handler: async (c) => {
        try {
          if (!isUserFilesEnabled()) {
            return c.json({ error: '用户文件功能未启用' }, 403);
          }
          const requestContext = c.get('requestContext') as RequestContext;
          const auth = trustedAuth(requestContext);
          const threadId = c.req.query('threadId');
          if (!threadId || !threadId.trim()) {
            return c.json({ error: 'threadId is required' }, 400);
          }
          // source / userId query params must never expand authority.
          const threadLookup = await threadLookupFor(c, lookup);
          await assertThreadOwned(auth, threadId.trim(), threadLookup);
          const limit = parseLimit(c.req.query('limit') ?? undefined);
          const cursor = c.req.query('cursor') || undefined;
          const repo = createArtifactRepository();
          const page = await repo.listArtifactRuns(auth, threadId.trim(), { limit, cursor });
          return c.json(page);
        } catch (error) {
          if (error instanceof ArtifactRepositoryError) {
            return c.json({ error: error.message }, error.status as 400);
          }
          if (error && typeof error === 'object' && 'status' in error && 'message' in error) {
            const status = Number((error as { status: number }).status);
            if (status >= 400 && status < 600) {
              return c.json({ error: String((error as { message: string }).message) }, status as 400);
            }
          }
          console.error('turn-artifacts list failed', error);
          return c.json({ error: 'Failed to list turn artifacts' }, 500);
        }
      },
    }),
  ];
}

export const turnArtifactRoutes = createTurnArtifactRoutes();
