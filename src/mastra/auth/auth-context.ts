import type { RequestContext } from '@mastra/core/request-context';
import type { AppRole, AuthUser } from './service';

const MASTRA_USER_KEY = 'mastra__user';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AuthContext = {
  userId: string;
  roles: AppRole[];
  tenantId?: string;
};

export function resourceIdFor(auth: AuthContext): string {
  return auth.userId;
}

export function authContextFromUser(user: AuthUser): AuthContext {
  if (!UUID_PATTERN.test(user.id)) {
    throw new Error('Authenticated identity is not a UUID');
  }
  return { userId: user.id, roles: user.roles };
}

export function trustedAuth(requestContext: RequestContext): AuthContext {
  return authContextFromUser(trustedUser(requestContext));
}

export function trustedUser(requestContext: RequestContext): AuthUser {
  const value = requestContext.get(MASTRA_USER_KEY);
  if (!isAuthUser(value)) {
    throw new Error('Authentication is required');
  }
  authContextFromUser(value);
  return value;
}

function isAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AuthUser>;
  return typeof candidate.id === 'string' && candidate.id.length > 0 && Array.isArray(candidate.roles)
    && candidate.roles.every(role => role === 'admin' || role === 'user');
}
