import type { MastraAuthConfig } from '@mastra/core/server';
import { authContextFromUser, resourceIdFor } from './auth-context';
import { getUserByToken, login, logout, type AuthUser } from './service';

type Session = { token: string; user: AuthUser };
type AuthFunctions = {
  login: (email: string, password: string) => Promise<Session | null>;
  getUserByToken: (token: string) => Promise<AuthUser | null>;
  logout: (token: string) => Promise<void>;
};
type AuthRequest = Parameters<NonNullable<MastraAuthConfig<AuthUser>['authenticateToken']>>[1];

const cookieName = 'nero_studio_session';

function cookieToken(request: AuthRequest): string {
  const header = request instanceof Request ? request.headers.get('cookie') ?? '' :
    request.header?.('cookie') ?? request.raw?.headers.get('cookie') ??
    (request.headers instanceof Headers ? request.headers.get('cookie') ?? '' :
      String(request.headers?.cookie ?? ''));
  const value = header.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!value) return '';
  try { return decodeURIComponent(value); } catch { return ''; }
}

function studioCookie(token: string, secure = false): string {
  return `${cookieName}=${encodeURIComponent(token)}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`;
}

function studioUser(user: AuthUser) {
  return { ...user, name: user.displayName };
}

export function createStudioAuth(auth: AuthFunctions) {
  const adminForToken = async (token: string) => {
    const user = await auth.getUserByToken(token);
    return user?.roles.includes('admin') ? studioUser(user) : null;
  };

  return {
    name: 'nero-agent-studio',
    isSignUpEnabled: () => false,
    signIn: async (email: string, password: string, request: Request) => {
      const session = await auth.login(email, password);
      if (!session) throw new Error('邮箱或密码错误');
      if (!session.user.roles.includes('admin')) {
        await auth.logout(session.token);
        throw new Error('仅管理员可以登录 Studio');
      }
      const secure = new URL(request.url).protocol === 'https:' ||
        request.headers.get('x-forwarded-proto') === 'https';
      return { token: session.token, user: studioUser(session.user),
        cookies: [studioCookie(session.token, secure)] };
    },
    authenticateToken: async (token: string, request: AuthRequest) =>
      adminForToken(cookieToken(request) || token),
    authorizeUser: (user: AuthUser, _request: AuthRequest) => user.roles.includes('admin'),
    getCurrentUser: async (request: Request) => {
      const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
      return adminForToken(cookieToken(request) || bearer || '');
    },
    getSessionIdFromRequest: (request: Request) => cookieToken(request),
    destroySession: (token: string) => auth.logout(token),
    getClearSessionHeaders: () => ({ 'Set-Cookie':
      `${cookieName}=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0` }),
    mapUserToResourceId: (user: AuthUser) => resourceIdFor(authContextFromUser(user)),
  };
}

export const studioAuth = createStudioAuth({ login, getUserByToken, logout });
