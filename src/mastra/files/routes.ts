import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import type { RequestContext } from '@mastra/core/request-context';
import { LocalFilesystem, type WorkspaceFilesystem } from '@mastra/core/workspace';
import { trustedAuth } from '../auth/auth-context';
import { ThreadGuardError, type ThreadLookup } from '../auth/thread-guard';
import { FilePathError, isUserFilesEnabled, maxFileSizeBytes, relativeFilePath } from './policy';
import { FileService, FileServiceError } from './service';
import { addRecursiveDirectorySizes, WorkspaceFileService } from './workspace-service';
import { AttachmentService, messageLookupFromRecall } from './attachments';
import { ensureUserWorkspace } from '../workspace/manager';
import { QuotaExceededError } from '../workspace/quota';
import { DiskProtectionError } from '../workspace/disk-protection';
import { readWorkspaceVersion, saveWorkspaceText, WorkspaceEditError } from './workspace-editor';

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function jsonError(
  c: Context,
  error: { message: string; status: 400 | 401 | 403 | 404 | 409 | 412 | 413; code?: string },
) {
  const status = error.code === 'FILE_TOO_LARGE' || error.code === 'WORKSPACE_QUOTA_EXCEEDED'
    ? 413 as const : error.status;
  if (error.code) return c.json({ error: error.message, code: error.code }, status);
  return c.json({ error: error.message }, error.status);
}

/** Same gate as `/user-files/*` for workspace write APIs. */
function requireUserFilesEnabled(c: Context): Response | undefined {
  if (!isUserFilesEnabled()) return c.json({ error: '文件功能未开放' }, 404);
  return undefined;
}

async function readLimitedFormData(c: Context): Promise<FormData> {
  const maxBytes = maxFileSizeBytes() + MULTIPART_OVERHEAD_BYTES;
  const lengthHeader = c.req.header('content-length');
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new FileServiceError(413, '文件过大', 'FILE_TOO_LARGE');
    }
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new FileServiceError(400, '缺少文件');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FileServiceError(413, '文件过大', 'FILE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  const contentType = c.req.header('content-type');
  if (!contentType) throw new FileServiceError(400, '缺少文件');
  return new Request('http://workspace.local/upload', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  }).formData();
}

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
  if (error instanceof QuotaExceededError) {
    return jsonError(c, error);
  }
  if (error instanceof DiskProtectionError) {
    return jsonError(c, { message: error.message, status: 409 });
  }
  if (error instanceof FilePathError || error instanceof FileServiceError || error instanceof ThreadGuardError ||
    error instanceof WorkspaceEditError) {
    return jsonError(c, error);
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
        const form = await readLimitedFormData(c);
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

async function currentWorkspace(
  c: Context,
  sourceOverride?: string,
): Promise<{ id: string; filesystem: WorkspaceFilesystem }> {
  const auth = trustedAuth(c.get('requestContext'));
  const source = sourceOverride ?? c.req.query('source');
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

export function createCurrentWorkspaceFileRoutes(lookup?: ThreadLookup) {
  function workspacePath(c: Context): string {
    const prefix = '/current-workspace/files/';
    const raw = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : c.req.param('*') ?? '';
    try { return relativeFilePath(decodeURIComponent(raw)); }
    catch { throw new FilePathError(); }
  }
  async function threadLookupFor(c: Context): Promise<ThreadLookup> {
    if (lookup) return lookup;
    const mastra = c.get('mastra') as {
      getAgent(id: string): { getMemory(args: { requestContext: unknown }): Promise<ThreadLookup> };
    } | undefined;
    const requestContext = c.get('requestContext');
    if (!mastra || !requestContext) throw new FileServiceError(401, 'Authentication is required');
    return mastra.getAgent('agent').getMemory({ requestContext });
  }
  async function attachmentsFor(c: Context): Promise<AttachmentService> {
    const requestContext = c.get('requestContext');
    const mastra = c.get('mastra') as {
      getAgent(id: string): {
        getMemory(args: { requestContext: unknown }): Promise<ThreadLookup & {
          recall?: (args: {
            threadId: string;
            resourceId?: string;
            page?: number;
            perPage?: number | false;
            includeTotal?: boolean;
            include?: Array<{ id: string }>;
            filter?: { metadata?: Record<string, string | number | boolean | null> };
          }) => Promise<{
            messages: Array<{ id: string; content?: { metadata?: Record<string, unknown> } }>;
            hasMore?: boolean;
          }>;
        }>;
      };
    } | undefined;
    const memory = mastra && requestContext ? await mastra.getAgent('agent').getMemory({ requestContext }) : undefined;
    return new AttachmentService(await threadLookupFor(c), {
      resolveAgentWorkspace: async () => currentWorkspace(c, 'agent'),
      messageLookup: memory?.recall ? messageLookupFromRecall(memory.recall.bind(memory)) : undefined,
    });
  }
  return [
    registerApiRoute('/current-workspace/upload', {
      method: 'POST',
      handler: async c => {
        try {
          const gated = requireUserFilesEnabled(c);
          if (gated) return gated;
          const auth = trustedAuth(c.get('requestContext'));
          if (c.req.query('source') === 'agent') throw new FileServiceError(403, '无权访问工作区');
          const form = await readLimitedFormData(c);
          const file = form.get('file');
          if (!(file instanceof File)) return c.json({ error: '缺少文件' }, 400);
          const entry = await new WorkspaceFileService().upload(auth, file);
          return c.json(entry, 201);
        } catch (error) { return respond(c, error); }
      },
    }),
    registerApiRoute('/current-workspace/files', {
      method: 'GET',
      handler: async c => {
        try {
          const auth = trustedAuth(c.get('requestContext'));
          if (!c.req.query('source')) {
            const listed = await new WorkspaceFileService().list(auth);
            return c.json({ workspaceId: `ws_${auth.userId}`, files: listed.files, usage: listed.usage });
          }
          const workspace = await currentWorkspace(c);
          const entries = await workspace.filesystem.readdir('.', { recursive: true });
          const files = addRecursiveDirectorySizes(entries.filter(entry => !entry.isSymlink)
            .map(entry => ({ path: entry.name, type: entry.type, size: entry.size ?? 0 })));
          return c.json({ workspaceId: workspace.id, files });
        } catch (error) { return respond(c, error); }
      },
    }),
    registerApiRoute('/current-workspace/files/batch-delete', {
      method: 'POST',
      handler: async c => {
        try {
          const gated = requireUserFilesEnabled(c);
          if (gated) return gated;
          const auth = trustedAuth(c.get('requestContext'));
          if (c.req.query('source') === 'agent') throw new FileServiceError(403, '无权访问工作区');
          const payload = await c.req.json().catch(() => undefined) as { paths?: unknown } | undefined;
          if (!payload || !Array.isArray(payload.paths)) {
            return c.json({ error: '删除路径无效' }, 400);
          }
          const paths = payload.paths.map(path => String(path));
          const result = await new WorkspaceFileService().batchDelete(auth, paths);
          return c.json(result);
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
          const asciiName = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
          const encodedName = encodeURIComponent(name).replace(/['()*]/g,
            char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
          return new Response(bytes, { status: 200, headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
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
          const auth = trustedAuth(c.get('requestContext'));
          const etag = await saveWorkspaceText(workspace.filesystem, path, text, c.req.header('if-match') ?? '',
            c.req.query('source') === 'agent' ? undefined : auth.userId);
          return c.json({ ok: true }, 200, { etag, 'cache-control': 'no-store' });
        } catch (error) { return respond(c, error); }
      },
    }),
    registerApiRoute('/current-workspace/attachments', {
      method: 'POST',
      handler: async c => {
        try {
          const gated = requireUserFilesEnabled(c);
          if (gated) return gated;
          trustedAuth(c.get('requestContext'));
          const payload = await c.req.json().catch(() => undefined) as {
            threadId?: string;
            clientMessageId?: string;
            items?: Array<{ source?: string; path?: string }>;
          } | undefined;
          if (!payload?.threadId || !payload.clientMessageId || !Array.isArray(payload.items)) {
            return c.json({ error: '附件请求无效' }, 400);
          }
          const attachments = await attachmentsFor(c);
          const refs = await attachments.prepare(
            trustedAuth(c.get('requestContext')),
            payload.threadId,
            payload.clientMessageId,
            payload.items.map(item => ({
              source: item.source as 'personal' | 'agent',
              path: String(item.path ?? ''),
            })),
          );
          return c.json({ attachments: refs });
        } catch (error) { return respond(c, error); }
      },
    }),
    registerApiRoute('/current-workspace/attachments', {
      method: 'GET',
      handler: async c => {
        try {
          const threadId = c.req.query('threadId') ?? '';
          if (!threadId) return c.json({ error: '缺少 threadId' }, 400);
          const attachments = await attachmentsFor(c);
          const refs = await attachments.listForThread(trustedAuth(c.get('requestContext')), threadId);
          return c.json({ attachments: refs });
        } catch (error) { return respond(c, error); }
      },
    }),
  ];
}

export const currentWorkspaceFileRoutes = createCurrentWorkspaceFileRoutes();
