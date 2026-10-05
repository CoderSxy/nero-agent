import { authContextFromUser, trustedAuth, type AuthContext } from './auth-context';
import { assertThreadOwned, ThreadGuardError, type ThreadLookup } from './thread-guard';
import { getUserByToken, type AuthUser } from './service';
import type { Context, Next } from 'hono';
import { RequestContext } from '@mastra/core/request-context';

type GuardRequest = {
  method: string;
  path: string;
  query?: Record<string, string> | ((key?: string) => string | Record<string, string> | undefined);
  raw?: Request;
};

type GuardContext = Context;

function queryOf(req: GuardRequest): Record<string, string> {
  if (typeof req.query === 'function') {
    const threadId = req.query('threadId');
    return typeof threadId === 'string' && threadId ? { threadId } : {};
  }
  const query = req.query;
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

async function lookupFromContext(context: GuardContext, requestContext: RequestContext): Promise<ThreadLookup> {
  const mastra = context.get('mastra') as {
    getAgent(id: string): { getMemory(args: { requestContext: unknown }): Promise<ThreadLookup> };
  } | undefined;
  if (!mastra) {
    throw new ThreadGuardError(401, 'Authentication is required');
  }
  const memory = await mastra.getAgent('agent').getMemory({ requestContext });
  return memory;
}

export const authorizeThreadRoute = {
  path: '*',
  handler: async (
    context: GuardContext,
    next: Next,
    lookup?: ThreadLookup,
    authenticate: (token: string) => Promise<AuthUser | null> = getUserByToken,
  ): Promise<Response | void> => {
    const method = context.req.method;
    const path = context.req.path;
    const query = queryOf(context.req as GuardRequest);
    const body = await readBody(context.req.raw);
    const threadId = extractThreadId(method, path, query, body);
    if (!threadId) {
      await next();
      return;
    }
    try {
      let requestContext = context.get('requestContext') as RequestContext | undefined;
      let auth: AuthContext | undefined;
      if (requestContext) {
        try {
          auth = trustedAuth(requestContext);
        } catch (error) {
          if (!(error instanceof Error && error.message === 'Authentication is required')) throw error;
        }
      }
      if (!auth) {
        const token = context.req.raw?.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
        if (!token) throw new ThreadGuardError(401, 'Authentication is required');
        const user = await authenticate(token);
        if (!user) throw new ThreadGuardError(401, 'Authentication is required');
        auth = authContextFromUser(user);
        requestContext ??= new RequestContext();
        requestContext.set('mastra__user', user);
      }
      if (!requestContext) throw new ThreadGuardError(401, 'Authentication is required');
      await assertThreadOwned(auth, threadId, lookup ?? await lookupFromContext(context, requestContext));
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
