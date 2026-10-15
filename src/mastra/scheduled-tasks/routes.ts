import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import type { AuthUser } from '../auth/service';
import {
  ScheduledTaskError,
  createScheduledTaskService,
  type ScheduleDriver,
  type ScheduledTaskService,
} from './service';

const MAX_BODY_BYTES = 32 * 1024;

class RequestError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404, message: string) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<ScheduledTaskError['code'], 400 | 403 | 404 | 409 | 502> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  upstream: 502,
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

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
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
  return parsed as Record<string, unknown>;
}

function parsePage(c: Context): { page: number; pageSize: number; q?: string } {
  const page = Number(c.req.query('page') ?? '1');
  const pageSize = Number(c.req.query('pageSize') ?? '20');
  if (!Number.isInteger(page) || page < 1) throw new RequestError(400, 'page 无效');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new RequestError(400, 'pageSize 无效');
  }
  const q = c.req.query('q')?.trim();
  return { page, pageSize, ...(q ? { q } : {}) };
}

function respond(c: Context, error: unknown) {
  if (error instanceof RequestError) return c.json({ error: error.message }, error.status);
  if (error instanceof ScheduledTaskError) {
    const status = STATUS_BY_CODE[error.code] ?? 400;
    return c.json({ error: error.message }, status);
  }
  console.error('scheduled task route failed', error instanceof Error ? error.name : 'unknown');
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

export function createScheduledTaskRoutes(
  resolveService: (c: Context) => ScheduledTaskService,
) {
  const base = '/agent-scheduled-tasks';
  return [
    registerApiRoute(base, {
      method: 'GET',
      handler: guarded(async (c, user) => {
        const page = parsePage(c);
        return c.json(await resolveService(c).list(user, page));
      }),
    }),
    registerApiRoute(base, {
      method: 'POST',
      handler: guarded(async (c, user) => {
        const body = await readJsonObject(c);
        return c.json({ task: await resolveService(c).create(user, body) }, 201);
      }),
    }),
    registerApiRoute(`${base}/:id`, {
      method: 'GET',
      handler: guarded(async (c, user) =>
        c.json({ task: await resolveService(c).get(user, c.req.param('id') ?? '') })),
    }),
    registerApiRoute(`${base}/:id`, {
      method: 'PATCH',
      handler: guarded(async (c, user) => {
        const body = await readJsonObject(c);
        return c.json({ task: await resolveService(c).edit(user, c.req.param('id') ?? '', body) });
      }),
    }),
    registerApiRoute(`${base}/:id`, {
      method: 'DELETE',
      handler: guarded(async (c, user) => {
        await resolveService(c).remove(user, c.req.param('id') ?? '');
        return c.json({ ok: true });
      }),
    }),
    registerApiRoute(`${base}/:id/pause`, {
      method: 'POST',
      handler: guarded(async (c, user) =>
        c.json({ task: await resolveService(c).pause(user, c.req.param('id') ?? '') })),
    }),
    registerApiRoute(`${base}/:id/resume`, {
      method: 'POST',
      handler: guarded(async (c, user) =>
        c.json({ task: await resolveService(c).resume(user, c.req.param('id') ?? '') })),
    }),
    registerApiRoute(`${base}/:id/run`, {
      method: 'POST',
      handler: guarded(async (c, user) =>
        c.json(await resolveService(c).run(user, c.req.param('id') ?? ''))),
    }),
    registerApiRoute(`${base}/:id/runs`, {
      method: 'GET',
      handler: guarded(async (c, user) => {
        const page = parsePage(c);
        return c.json(await resolveService(c).runs(user, c.req.param('id') ?? '', page));
      }),
    }),
  ];
}

function serviceFromContext(c: Context): ScheduledTaskService {
  const mastra = c.get('mastra') as { schedules: ScheduleDriver } | undefined;
  if (!mastra?.schedules) throw new Error('Mastra schedules unavailable');
  return createScheduledTaskService(mastra.schedules);
}

export const scheduledTaskRoutes = createScheduledTaskRoutes(serviceFromContext);
