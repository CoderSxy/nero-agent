import { registerApiRoute } from '@mastra/core/server';
import { createUser, getUserByToken, login, logout, type AppRole, type AuthUser } from './service';
import { clearStudioSessionCookie, studioGatewayAuthorization, studioSessionCookie } from './studio-proxy';

function bearer(header: string | undefined): string {
  return header?.match(/^Bearer (.+)$/i)?.[1] || '';
}

function secureRequest(url: string, forwardedProto?: string): boolean {
  return new URL(url).protocol === 'https:' || forwardedProto === 'https';
}

export const authRoutes = [
  registerApiRoute('/auth/login', {
    method: 'POST', requiresAuth: false,
    handler: async c => {
      let body: { email?: unknown; password?: unknown };
      try { body = await c.req.json(); } catch { return c.json({ error: '请求格式无效' }, 400); }
      if (typeof body.email !== 'string' || typeof body.password !== 'string' ||
        body.email.length > 320 || body.password.length > 256) return c.json({ error: '请求格式无效' }, 400);
      const session = await login(body.email, body.password);
      return session ? c.json(session) : c.json({ error: '邮箱或密码错误' }, 401);
    },
  }),
  registerApiRoute('/auth/me', {
    method: 'GET', handler: async c => c.json({ user: c.get('requestContext').get('user') as AuthUser }),
  }),
  registerApiRoute('/auth/logout', {
    method: 'POST', handler: async c => {
      await logout(bearer(c.req.header('authorization')));
      c.header('Set-Cookie', clearStudioSessionCookie(secureRequest(c.req.url, c.req.header('x-forwarded-proto'))));
      return c.json({ ok: true });
    },
  }),
  registerApiRoute('/auth/studio-session', {
    method: 'POST', handler: async c => {
      const actor = c.get('requestContext').get('user') as AuthUser | undefined;
      const adminId = process.env.STUDIO_ADMIN_USER_ID;
      const proxyKey = process.env.STUDIO_PROXY_KEY;
      if (!adminId || !proxyKey) {
        if (process.env.NODE_ENV !== 'production') return c.body(null, 204);
        return c.json({ error: 'Studio 网关未配置' }, 503);
      }
      if (actor?.id !== adminId || !actor.roles.includes('admin'))
        return c.json({ error: '仅管理员可以进入 Studio' }, 403);
      const token = bearer(c.req.header('authorization'));
      c.header('Set-Cookie', studioSessionCookie(token, secureRequest(c.req.url, c.req.header('x-forwarded-proto'))));
      return c.body(null, 204);
    },
  }),
  registerApiRoute('/auth/studio-gate', {
    method: 'GET', requiresAuth: false,
    handler: async c => {
      const adminId = process.env.STUDIO_ADMIN_USER_ID;
      const proxyKey = process.env.STUDIO_PROXY_KEY;
      if (!adminId || !proxyKey) return c.body(null, 503);
      const authorization = await studioGatewayAuthorization(
        c.req.header('cookie') ?? '', adminId, proxyKey, getUserByToken);
      if (!authorization) return c.body(null, 401);
      c.header('X-Studio-Proxy-Authorization', authorization);
      return c.body(null, 204);
    },
  }),
  registerApiRoute('/auth/users', {
    method: 'POST', handler: async c => {
      const actor = c.get('requestContext').get('user') as AuthUser | undefined;
      if (!actor?.roles.includes('admin')) return c.json({ error: '无权创建用户' }, 403);
      let body: { email?: unknown; displayName?: unknown; password?: unknown; role?: unknown };
      try { body = await c.req.json(); } catch { return c.json({ error: '请求格式无效' }, 400); }
      if (typeof body.email !== 'string' || typeof body.displayName !== 'string' ||
          typeof body.password !== 'string' || (body.role !== 'admin' && body.role !== 'user'))
        return c.json({ error: '请求格式无效' }, 400);
      try {
        const user = await createUser({ email: body.email, displayName: body.displayName,
          password: body.password, role: body.role as AppRole });
        return c.json({ user }, 201);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : '创建用户失败' }, 400);
      }
    },
  }),
];
