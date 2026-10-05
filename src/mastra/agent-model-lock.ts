/**
 * Mastra's built-in agent model-management routes call `Agent.__updateModel` and friends, which would
 * permanently replace the per-request catalog model. Model selection is owned by the model catalog.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AGENT_MODEL_PATH = /^\/api\/agents\/[^/]+\/models?(?:\/|$)/i;
const AGENT_PATH = /^\/api\/agents\/[^/]+(?:\/|$)/i;

export function isAgentModelOverrideRequest(method: string, path: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  return AGENT_MODEL_PATH.test(path);
}

type LockContext = { req: { path: string; method: string; raw?: Request } };

async function hasBodyModelOverride(request?: Request): Promise<boolean> {
  if (!request?.headers.get('content-type')?.toLowerCase().includes('application/json')) return false;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return false;
  }
  const hasOverride = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const fields = value as Record<string, unknown>;
    if (Object.hasOwn(fields, 'model')) return true;
    const structured = fields.structuredOutput;
    return !!structured && typeof structured === 'object' && Object.hasOwn(structured, 'model');
  };
  if (hasOverride(body)) return true;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const fields = body as Record<string, unknown>;
  const idle = fields.ifIdle;
  return !!idle && typeof idle === 'object' && hasOverride((idle as Record<string, unknown>).streamOptions);
}

export const agentModelLockMiddleware = {
  path: '*',
  handler: async (context: LockContext, next: () => Promise<void>): Promise<Response | void> => {
    if (isAgentModelOverrideRequest(context.req.method, context.req.path)
      || (MUTATING_METHODS.has(context.req.method.toUpperCase())
        && AGENT_PATH.test(context.req.path)
        && await hasBodyModelOverride(context.req.raw))) {
      return new Response(
        JSON.stringify({ error: '智能体模型由模型目录统一管理，不允许通过内置接口修改' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    }
    await next();
  },
};
