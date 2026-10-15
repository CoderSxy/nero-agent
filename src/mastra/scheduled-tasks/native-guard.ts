import type { Context, Next } from 'hono';
import { studioAuth } from '../auth/studio';
import { getUserByToken, type AuthUser } from '../auth/service';

const SCHEDULE_API = /^\/api\/schedules(?:\/|$)/i;

export function isNativeSchedulePath(path: string): boolean {
  return SCHEDULE_API.test(path);
}

/**
 * Block ordinary app clients from Mastra's native schedule CRUD.
 * Studio access requires a verified `nero_studio_session` cookie for an admin.
 * Never trust `x-mastra-client-type` alone, and do not treat app Bearer tokens
 * as Studio authentication.
 */
export async function isStudioAdminRequest(
  request: Request,
  authenticate: (token: string) => Promise<AuthUser | null> = getUserByToken,
): Promise<boolean> {
  const cookieToken = studioAuth.getSessionIdFromRequest(request);
  if (!cookieToken) return false;
  const user = await authenticate(cookieToken);
  return Boolean(user?.roles.includes('admin'));
}

export const nativeScheduleGuardMiddleware = {
  path: '*',
  handler: async (context: Context, next: Next): Promise<Response | void> => {
    const path = context.req.path;
    if (!isNativeSchedulePath(path)) {
      await next();
      return;
    }
    const allowed = await isStudioAdminRequest(context.req.raw);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: '禁止直接访问原生调度接口，请使用应用定时任务 API' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    }
    await next();
  },
};
