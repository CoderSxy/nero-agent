import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import type { RequestContext } from '@mastra/core/request-context';
import { LocalFilesystem, type WorkspaceFilesystem } from '@mastra/core/workspace';
import { trustedAuth } from '../auth/auth-context';
import { ThreadGuardError, type ThreadLookup } from '../auth/thread-guard';
import { FilePathError, isUserFilesEnabled, relativeFilePath } from './policy';
import { FileService, FileServiceError } from './service';
import { ensureUserWorkspace } from '../workspace/manager';
import { readWorkspaceVersion, saveWorkspaceText, WorkspaceEditError } from './workspace-editor';

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
  if (error instanceof FilePathError || error instanceof FileServiceError || error instanceof ThreadGuardError ||
    error instanceof WorkspaceEditError) {
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof Error && /Authentication is required/i.test(error.message)) {
    return c.json({ error: error.message }, 401);
  }
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    return c.json({ error: '文件不存在' }, 404);
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

async function currentWorkspace(c: Context): Promise<{ id: string; filesystem: WorkspaceFilesystem }> {
  const auth = trustedAuth(c.get('requestContext'));
  const source = c.req.query('source');
  if (source && source !== 'agent') throw new FilePathError('工作区来源无效');
  if (!source) {
    const root = await ensureUserWorkspace(auth);
    return { id: `ws_${auth.userId}`, filesystem: new LocalFilesystem({ basePath: root, contained: true }) };
  }
  if (!auth.roles.includes('admin')) throw new FileServiceError(403, '无权访问工作区');
  const mastra = c.get('mastra') as {
    getAgent(id: string): { getWorkspace(args: { requestContext: RequestContext }):
      Promise<{ id: string; filesystem?: WorkspaceFilesystem } | undefined> };
  } | undefined;
  const requestContext = c.get('requestContext') as RequestContext | undefined;
  if (!mastra || !requestContext) throw new FileServiceError(401, 'Authentication is required');
  const workspace = await mastra.getAgent('agent').getWorkspace({ requestContext });
  if (!workspace?.filesystem) throw new FileServiceError(404, '当前用户没有可浏览的工作区');
  return { id: workspace.id, filesystem: workspace.filesystem };
}

export function createCurrentWorkspaceFileRoutes() {
  function workspacePath(c: Context): string {
    const prefix = '/current-workspace/files/';
    const raw = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : c.req.param('*') ?? '';
    try { return relativeFilePath(decodeURIComponent(raw)); }
    catch { throw new FilePathError(); }
  }
  return [
    registerApiRoute('/current-workspace/files', {
      method: 'GET',
      handler: async c => {
        try {
          const workspace = await currentWorkspace(c);
          const entries = await workspace.filesystem.readdir('.', { recursive: true });
          return c.json({ workspaceId: workspace.id, files: entries.filter(entry => !entry.isSymlink)
            .map(entry => ({ path: entry.name, type: entry.type, size: entry.size ?? 0 })) });
        } catch (error) { return respond(c, error); }
      },
    }),
    registerApiRoute('/current-workspace/files/*', {
      method: 'GET',
      handler: async c => {
        try {
          const workspace = await currentWorkspace(c);
          const path = workspacePath(c);
          const data = await workspace.filesystem.readFile(path);
          const bytes = typeof data === 'string' ? Buffer.from(data) : new Uint8Array(data);
          const name = path.split('/').at(-1) ?? 'download';
          return new Response(bytes, { status: 200, headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${name.replace(/["\r\n]/g, '')}"`,
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
            etag: readWorkspaceVersion(bytes),
          } });
        } catch (error) { return respond(c, error); }
      },
    }),
    registerApiRoute('/current-workspace/files/*', {
      method: 'PUT',
      handler: async c => {
        try {
          const workspace = await currentWorkspace(c);
          const path = workspacePath(c);
          const contentType = c.req.header('content-type') ?? '';
          if (!/^text\/plain(?:\s*;\s*charset=utf-8)?$/i.test(contentType))
            throw new WorkspaceEditError(400, '只接受 UTF-8 文本');
          const body = new Uint8Array(await c.req.arrayBuffer());
          if (body.length > 10 * 1024 * 1024) throw new WorkspaceEditError(413, '文件超过在线编辑上限');
          let text: string;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
          catch { throw new WorkspaceEditError(400, '文件包含无效 UTF-8 文本'); }
          const etag = await saveWorkspaceText(workspace.filesystem, path, text, c.req.header('if-match') ?? '');
          return c.json({ ok: true }, 200, { etag, 'cache-control': 'no-store' });
        } catch (error) { return respond(c, error); }
      },
    }),
  ];
}

export const currentWorkspaceFileRoutes = createCurrentWorkspaceFileRoutes();
