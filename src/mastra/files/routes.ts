import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { trustedAuth } from '../auth/auth-context';
import { ThreadGuardError, type ThreadLookup } from '../auth/thread-guard';
import { FilePathError, isUserFilesEnabled } from './policy';
import { FileService, FileServiceError } from './service';

function filePathFromRequest(c: Context, threadId: string): string {
  const prefix = `/user-files/${threadId}/`;
  const path = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : (c.req.param('*') ?? '');
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function respond(c: Context, error: unknown) {
  if (error instanceof FilePathError || error instanceof FileServiceError || error instanceof ThreadGuardError) {
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof Error && /Authentication is required/i.test(error.message)) {
    return c.json({ error: error.message }, 401);
  }
  return c.json({ error: '服务器内部错误' }, 500);
}

function serviceFor(c: Context, lookup?: ThreadLookup) {
  if (lookup) return new FileService(lookup);
  const mastra = c.get('mastra') as {
    getAgent(id: string): { getMemory(args: { requestContext: unknown }): Promise<ThreadLookup> };
  } | undefined;
  const requestContext = c.get('requestContext');
  if (!mastra || !requestContext) throw new FileServiceError(401, 'Authentication is required');
  return mastra.getAgent('agent').getMemory({ requestContext }).then(memory => new FileService(memory));
}

function guarded(lookup: ThreadLookup | undefined, run: (c: Context, service: FileService) => Promise<Response>) {
  return async (c: Context) => {
    try {
      if (!isUserFilesEnabled()) return c.json({ error: '文件功能未开放' }, 404);
      trustedAuth(c.get('requestContext'));
      const service = await serviceFor(c, lookup);
      return await run(c, service);
    } catch (error) {
      return respond(c, error);
    }
  };
}

export function createFileRoutes(lookup?: ThreadLookup) {
  return [
    registerApiRoute('/user-files/upload', {
      method: 'POST',
      handler: guarded(lookup, async (c, service) => {
        const auth = trustedAuth(c.get('requestContext'));
        const form = await c.req.formData();
        const threadId = String(form.get('threadId') ?? '');
        const path = String(form.get('path') ?? '');
        const file = form.get('file');
        if (!(file instanceof File)) return c.json({ error: '缺少文件' }, 400);
        const data = Buffer.from(await file.arrayBuffer());
        await service.write(auth, threadId, path || file.name, data);
        return c.json({ path: path || file.name }, 201);
      }),
    }),
    registerApiRoute('/user-files/:threadId', {
      method: 'GET',
      handler: guarded(lookup, async (c, service) => {
        const auth = trustedAuth(c.get('requestContext'));
        const files = await service.list(auth, c.req.param('threadId') ?? '');
        return c.json({ files });
      }),
    }),
    registerApiRoute('/user-files/:threadId/*', {
      method: 'GET',
      handler: guarded(lookup, async (c, service) => {
        const auth = trustedAuth(c.get('requestContext'));
        const threadId = c.req.param('threadId') ?? '';
        const { data, name } = await service.read(auth, threadId, filePathFromRequest(c, threadId));
        return new Response(data, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
          },
        });
      }),
    }),
    registerApiRoute('/user-files/:threadId/*', {
      method: 'DELETE',
      handler: guarded(lookup, async (c, service) => {
        const auth = trustedAuth(c.get('requestContext'));
        const threadId = c.req.param('threadId') ?? '';
        await service.delete(auth, threadId, filePathFromRequest(c, threadId));
        return c.json({ ok: true });
      }),
    }),
  ];
}

export const fileRoutes = createFileRoutes();
