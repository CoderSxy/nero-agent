import { SimpleAuth } from '@mastra/core/server';
import { DEFAULT_ROLES, StaticRBACProvider } from '@mastra/core/auth/ee';
import { authContextFromUser, resourceIdFor } from './auth-context';
import type { AuthUser } from './service';

export const studioGatewayCookieName = 'nero_studio_gateway';

export function studioSessionCookie(token: string, secure: boolean): string {
  return `${studioGatewayCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}` +
    'SameSite=Strict; Max-Age=604800';
}

export function clearStudioSessionCookie(secure: boolean): string {
  return `${studioGatewayCookieName}=; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}` +
    'SameSite=Strict; Max-Age=0';
}

function sessionFromCookie(cookieHeader: string): string {
  const encoded = cookieHeader.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${studioGatewayCookieName}=`))?.slice(studioGatewayCookieName.length + 1);
  if (!encoded) return '';
  try { return decodeURIComponent(encoded); } catch { return ''; }
}

export async function studioGatewayAuthorization(
  cookieHeader: string,
  adminId: string,
  proxyKey: string,
  findUser: (token: string) => Promise<AuthUser | null>,
): Promise<string | null> {
  const token = sessionFromCookie(cookieHeader);
  if (!token) return null;
  const user = await findUser(token);
  return user?.id === adminId && user.roles.includes('admin') ? `Bearer ${proxyKey}` : null;
}

export function createStudioProxyAuth(proxyKey: string, admin: AuthUser) {
  if (proxyKey.length < 32) throw new Error('STUDIO_PROXY_KEY 至少需要 32 个字符');
  if (!admin.id || !admin.roles.includes('admin')) throw new Error('Studio 管理员配置无效');
  const studioUser = { ...admin, name: admin.displayName };
  return new SimpleAuth<typeof studioUser>({
    name: 'nero-studio-proxy',
    tokens: { [proxyKey]: studioUser },
    authorizeUser: user => user.id === admin.id && user.roles.includes('admin'),
    mapUserToResourceId: user => resourceIdFor(authContextFromUser(user)),
  });
}

export function createStudioProxyRBAC() {
  return new StaticRBACProvider<AuthUser>({
    roles: DEFAULT_ROLES,
    getUserRoles: user => user.roles.includes('admin') ? ['owner'] : [],
  });
}
