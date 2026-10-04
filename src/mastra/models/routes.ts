import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import type { AuthUser } from '../auth/service';
import {
  createModel,
  deleteModel,
  listManagedModels,
  listSelectableModels,
  updateModel,
} from './service';
import { ModelCatalogError, type ModelInput, type ModelScope } from './types';

const MAX_BODY_BYTES = 16 * 1024;

class RequestError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404, message: string) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<string, 400 | 403 | 404> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  disabled: 400,
  missing_key: 400,
  no_public_models: 400,
  legacy_ambiguous: 400,
};

function currentUser(c: Context): AuthUser {
  const user = (c.get('requestContext') as { get(key: string): unknown } | undefined)?.get('user') as
    | AuthUser
    | undefined;
  if (!user || typeof user.id !== 'string' || !Array.isArray(user.roles)) {
    throw new RequestError(401, '未登录');
  }
  return user;
}

function requireAdminForPublic(scope: ModelScope, user: AuthUser): void {
  if (scope === 'public' && !user.roles.includes('admin')) throw new RequestError(403, '无权管理公共模型');
}

async function readJsonObject<T extends object>(c: Context): Promise<T> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new RequestError(400, '请求体过大');

  const stream = c.req.raw.body;
  if (!stream) throw new RequestError(400, '请求格式无效');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RequestError(400, '请求体过大');
    }
    chunks.push(value);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, '请求格式无效');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestError(400, '请求格式无效');
  }
  return parsed as T;
}

function respond(c: Context, error: unknown) {
  if (error instanceof RequestError) return c.json({ error: error.message }, error.status);
  if (error instanceof ModelCatalogError) {
    return c.json({ error: error.message }, STATUS_BY_CODE[error.code] ?? 400);
  }
  console.error('model catalog route failed', error instanceof Error ? error.name : 'unknown');
  return c.json({ error: '服务器内部错误' }, 500);
}

function guarded(run: (c: Context, user: AuthUser) => Promise<Response>) {
  return async (c: Context) => {
    try {
      return await run(c, currentUser(c));
    } catch (error) {
      return respond(c, error);
    }
  };
}

function scopedRoutes(scope: ModelScope) {
  const base = `/model-catalog/${scope}`;
  return [
    registerApiRoute(base, {
      method: 'GET',
      handler: guarded(async (c, user) => {
        requireAdminForPublic(scope, user);
        return c.json({ models: await listManagedModels(scope, user) });
      }),
    }),
    registerApiRoute(base, {
      method: 'POST',
      handler: guarded(async (c, user) => {
        requireAdminForPublic(scope, user);
        const input = await readJsonObject<ModelInput>(c);
        return c.json({ model: await createModel(scope, user, input) }, 201);
      }),
    }),
    registerApiRoute(`${base}/:id`, {
      method: 'PATCH',
      handler: guarded(async (c, user) => {
        requireAdminForPublic(scope, user);
        const patch = await readJsonObject<Partial<ModelInput>>(c);
        return c.json({ model: await updateModel(scope, c.req.param('id') ?? '', user, patch) });
      }),
    }),
    registerApiRoute(`${base}/:id`, {
      method: 'DELETE',
      handler: guarded(async (c, user) => {
        requireAdminForPublic(scope, user);
        await deleteModel(scope, c.req.param('id') ?? '', user);
        return c.json({ ok: true });
      }),
    }),
  ];
}

export const modelRoutes = [
  registerApiRoute('/model-catalog', {
    method: 'GET',
    handler: guarded(async (c, user) => c.json({ models: await listSelectableModels(user) })),
  }),
  ...scopedRoutes('private'),
  ...scopedRoutes('public'),
];
