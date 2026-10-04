/**
 * Mastra's built-in agent model-management routes call `Agent.__updateModel` and friends, which would
 * permanently replace the per-request catalog model. Model selection is owned by the model catalog.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AGENT_MODEL_PATH = /^\/api\/agents\/[^/]+\/models?(?:\/|$)/i;

export function isAgentModelOverrideRequest(method: string, path: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  return AGENT_MODEL_PATH.test(path);
}

type LockContext = { req: { path: string; method: string } };

export const agentModelLockMiddleware = {
  path: '*',
  handler: async (context: LockContext, next: () => Promise<void>): Promise<Response | void> => {
    if (isAgentModelOverrideRequest(context.req.method, context.req.path)) {
      return new Response(
        JSON.stringify({ error: '智能体模型由模型目录统一管理，不允许通过内置接口修改' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    }
    await next();
  },
};
