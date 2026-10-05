import { trustedAuth } from './auth-context';
import { assertThreadOwned, ThreadGuardError, type ThreadLookup } from './thread-guard';

type GuardRequest = {
  method: string;
  path: string;
  query?: Record<string, string>;
  raw?: Request;
};

type GuardContext = {
  req: GuardRequest;
  get(key: string): unknown;
  json(body: unknown, status?: number): Response;
};

function queryOf(req: GuardRequest): Record<string, string> {
  const query = req.query as unknown;
  if (typeof query === 'function') {
    const threadId = (query as (key: string) => unknown)('threadId');
    return typeof threadId === 'string' && threadId ? { threadId } : {};
  }
  if (query && typeof query === 'object') return query as Record<string, string>;
  const url = req.raw ? new URL(req.raw.url) : undefined;
  if (!url) return {};
  return Object.fromEntries(url.searchParams.entries());
}

export function extractThreadId(
  _method: string,
  path: string,
  query: Record<string, string>,
  body: unknown,
): string | undefined {
  const pathMatch = path.match(/\/api\/memory\/(?:network\/)?threads\/([^/?]+)/);
  if (pathMatch?.[1]) return pathMatch[1];
  if (typeof query.threadId === 'string' && query.threadId) return query.threadId;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const fields = body as Record<string, unknown>;
  if (typeof fields.threadId === 'string' && fields.threadId) return fields.threadId;
  const memory = fields.memory;
  if (memory && typeof memory === 'object' && !Array.isArray(memory)) {
    const thread = (memory as { thread?: unknown }).thread;
    if (typeof thread === 'string' && thread) return thread;
  }
  return undefined;
}

function respond(context: GuardContext, body: unknown, status: number): Response {
  if (typeof context.json === 'function') return context.json(body, status);
  return Response.json(body, { status });
}

async function readBody(request?: Request): Promise<unknown> {
  if (!request?.headers.get('content-type')?.toLowerCase().includes('application/json')) return undefined;
  try {
    return await request.clone().json();
  } catch {
    return undefined;
  }
}

async function lookupFromContext(context: GuardContext): Promise<ThreadLookup> {
  const mastra = context.get('mastra') as {
    getAgent(id: string): { getMemory(args: { requestContext: unknown }): Promise<ThreadLookup> };
  } | undefined;
  const requestContext = context.get('requestContext');
  if (!mastra || !requestContext) {
    throw new ThreadGuardError(401, 'Authentication is required');
  }
  const memory = await mastra.getAgent('agent').getMemory({ requestContext });
  return memory;
}

export const authorizeThreadRoute = {
  path: '*',
  handler: async (
    context: GuardContext,
    next: () => Promise<void>,
    lookup?: ThreadLookup,
  ): Promise<Response | void> => {
    const method = context.req.method;
    const path = context.req.path;
    const query = queryOf(context.req);
    const body = await readBody(context.req.raw);
    const threadId = extractThreadId(method, path, query, body);
    if (!threadId) {
      await next();
      return;
    }
    try {
      const requestContext = context.get('requestContext') as Parameters<typeof trustedAuth>[0] | undefined;
      if (!requestContext) throw new ThreadGuardError(401, 'Authentication is required');
      const auth = trustedAuth(requestContext);
      await assertThreadOwned(auth, threadId, lookup ?? await lookupFromContext(context));
      await next();
    } catch (error) {
      if (error instanceof ThreadGuardError) {
        return respond(context, { error: error.message }, error.status);
      }
      if (error instanceof Error && /Authentication is required/i.test(error.message)) {
        return respond(context, { error: error.message }, 401);
      }
      throw error;
    }
  },
};
