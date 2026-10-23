import { recordWrittenFile } from '../agents/task-quality/file-evidence';
import { createTool } from '@mastra/core/tools';
import { LocalFilesystem } from '@mastra/core/workspace';
import { z } from 'zod';
import { trustedAuth } from '../auth/auth-context';
import type { ThreadLookup } from '../auth/thread-guard';
import type { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import { effectiveModelSupportsVision, findAuthorizedModel } from '../models/service';
import { resolveSelectedModel, trustedUserFrom } from '../models/resolver';
import { AttachmentService, type AttachmentStatus } from './attachments';
import { type FileToolScope, resolveFileToolRoot, resolveScopedPath } from './file-scope';
import { globFiles, grepFiles } from './file-search';
import {
  resolveArtifactRunContext,
  withTrackedMutation,
  type WorkspaceMutationToken,
} from './artifacts/collector';
import { normalizeArtifactPath } from './artifacts/paths';
import { maxFileSizeBytes, relativeFilePath } from './policy';
import { FileService } from './service';
import { replaceWorkspaceText } from './workspace-editor';
import { bindSkillThreadId, readBoundServerExecutionId } from '../skills/execution-context';
import { randomUUID } from 'node:crypto';

const pathInput = z.object({ path: z.string().min(1) });
const scopeInput = z.enum(['thread', 'workspace']).optional();
const TEXT_BYTE_LIMIT = 64 * 1024;
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|yaml|x-yaml|toml|csv|sql))/i;

function agentThreadId(context: { agent?: { threadId?: string } }): string {
  const threadId = context.agent?.threadId;
  if (!threadId) throw new Error('Agent thread is required for file operations');
  return threadId;
}

async function threadLookupFrom(context: {
  mastra?: unknown;
  requestContext?: unknown;
}): Promise<ThreadLookup> {
  if (!context.mastra || !context.requestContext) throw new Error('Authentication is required');
  const memory = await (context.mastra as Mastra)
    .getAgent('agent')
    .getMemory({ requestContext: context.requestContext as RequestContext });
  if (!memory) throw new Error('Agent memory is unavailable');
  return memory as ThreadLookup;
}

function serviceFrom(context: { mastra?: unknown; requestContext?: unknown }) {
  return threadLookupFrom(context).then(lookup => new FileService(lookup));
}

function fileToolScope(scope: FileToolScope | undefined): FileToolScope {
  return scope ?? 'thread';
}

function encodeApplicationPath(scope: FileToolScope, threadId: string, relativePath: string): string {
  const encoded = relativePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  if (scope === 'workspace') return `/current-workspace/files/${encoded}`;
  return `/user-files/${encodeURIComponent(threadId)}/${encoded}`;
}

async function defaultAttachmentsFrom(context: {
  mastra?: unknown;
  requestContext?: unknown;
}): Promise<AttachmentService> {
  if (!context.mastra || !context.requestContext) throw new Error('Authentication is required');
  const mastra = context.mastra as Mastra;
  const requestContext = context.requestContext as RequestContext;
  const memory = await mastra.getAgent('agent').getMemory({ requestContext });
  if (!memory) throw new Error('Agent memory is unavailable');
  return new AttachmentService(memory as ThreadLookup, {
    resolveAgentWorkspace: async () => {
      const workspace = await mastra.getAgent('agent').getWorkspace({ requestContext });
      if (!workspace) return undefined;
      return workspace as { filesystem: { basePath?: string } };
    },
  });
}

/** Server-authoritative vision gate. Never trusts client requestContext flags. */
async function defaultModelSupportsVision(requestContext: RequestContext): Promise<boolean> {
  const user = trustedUserFrom(requestContext);
  const { ref } = await resolveSelectedModel(requestContext, 'chat');
  const record = await findAuthorizedModel(ref, user);
  return effectiveModelSupportsVision(record);
}

export type AttachedFileToolResult = {
  attachmentId: string;
  name: string;
  status: AttachmentStatus;
  mimeType: string;
  kind: 'text' | 'image' | 'binary' | 'unavailable';
  content?: string;
  truncated?: boolean;
  imageBase64?: string;
};

export type AttachedFileDisplay = {
  attachmentId: string;
  name: string;
  status: AttachmentStatus;
};

function toDisplay(output: AttachedFileToolResult): AttachedFileDisplay {
  return {
    attachmentId: output.attachmentId,
    name: output.name,
    status: output.status,
  };
}

function isTextMime(mimeType: string, name: string): boolean {
  if (TEXT_MIME.test(mimeType)) return true;
  if (mimeType === 'application/octet-stream' || !mimeType) {
    return /\.(txt|md|markdown|csv|json|xml|yaml|yml|toml|log|ts|tsx|js|jsx|py|rs|go|java|c|h|cpp|css|html|svg)$/i
      .test(name);
  }
  return false;
}

function truncateUtf8(data: Buffer, limit: number): { content: string; truncated: boolean } {
  if (data.byteLength <= limit) {
    return { content: data.toString('utf8'), truncated: false };
  }
  let end = limit;
  while (end > 0 && (data[end] & 0xc0) === 0x80) end -= 1;
  return { content: data.subarray(0, end).toString('utf8'), truncated: true };
}

export type ReadAttachedFileDeps = {
  attachmentsFrom?: (context: {
    mastra?: unknown;
    requestContext?: unknown;
  }) => Promise<AttachmentService>;
  modelSupportsVision?: (requestContext: RequestContext) => Promise<boolean>;
};

function workspaceAttachmentRefText(result: Pick<AttachedFileToolResult, 'attachmentId' | 'name' | 'status'>): string {
  return `[workspace-attachment:${result.attachmentId} name=${result.name} status=${result.status}]`;
}

/** Build the multimodal payload the LLM should see for the current turn only (not persisted). */
export function attachedFileModelOutputForTurn(result: AttachedFileToolResult): unknown {
  if (result.kind === 'image' && result.imageBase64) {
    return {
      type: 'content',
      value: [
        {
          type: 'text',
          text: `附件 ${result.name}（${result.attachmentId}），状态 ${result.status}`,
        },
        {
          // Match normalizeModelOutput storage/prompt shape (media, not image-data).
          type: 'media',
          data: result.imageBase64,
          mediaType: result.mimeType,
        },
      ],
    };
  }
  return undefined;
}

function isBinaryMediaPart(part: { type?: string; data?: unknown; url?: unknown }): boolean {
  if (part.type === 'image-data' || part.type === 'file-data' || part.type === 'media') {
    return typeof part.data === 'string' && part.data.length > 0;
  }
  if (part.type === 'image-url' || part.type === 'file-url') {
    return typeof part.url === 'string' && /^data:/i.test(part.url);
  }
  return false;
}

/** Strip image bytes / multimodal parts before messages or observations are stored. */
export function sanitizeAttachedFileForPersistence(
  result: AttachedFileToolResult,
  modelOutput?: unknown,
): { result: AttachedFileDisplay; modelOutput: unknown } {
  let sanitizedModel = modelOutput;
  if (modelOutput && typeof modelOutput === 'object' && modelOutput !== null) {
    const typed = modelOutput as { type?: string; value?: unknown[] };
    if (typed.type === 'content' && Array.isArray(typed.value)) {
      sanitizedModel = {
        type: 'content',
        value: typed.value.map(part => {
          if (!part || typeof part !== 'object') return part;
          const item = part as { type?: string; text?: string; data?: unknown; url?: unknown };
          if (isBinaryMediaPart(item)) {
            return {
              type: 'text',
              text: workspaceAttachmentRefText(result),
            };
          }
          return part;
        }),
      };
    }
  }
  return { result: toDisplay(result), modelOutput: sanitizedModel };
}

export function createReadAttachedFileTool(deps: ReadAttachedFileDeps = {}) {
  const attachmentsFrom = deps.attachmentsFrom ?? defaultAttachmentsFrom;
  const modelSupportsVision = deps.modelSupportsVision ?? defaultModelSupportsVision;

  return createTool({
    id: 'read_attached_file',
    description:
      '按附件 ID 读取当前会话已登记的附件。文本返回有限 UTF-8 内容；图片仅在当前模型支持视觉时以多模态形式提供。',
    inputSchema: z.object({
      attachmentId: z.string().uuid().describe('服务端签发的附件 ID'),
    }),
    outputSchema: z.object({
      attachmentId: z.string(),
      name: z.string(),
      status: z.enum(['available', 'changed', 'deleted']),
      mimeType: z.string(),
      kind: z.enum(['text', 'image', 'binary', 'unavailable']),
      content: z.string().optional(),
      truncated: z.boolean().optional(),
      imageBase64: z.string().optional(),
    }),
    execute: async ({ attachmentId }, context) => {
      if (!context?.requestContext) throw new Error('Authentication is required');
      const auth = trustedAuth(context.requestContext);
      const threadId = agentThreadId(context);
      const attachments = await attachmentsFrom(context);
      const { ref, data } = await attachments.readOwned(auth, threadId, attachmentId);
      if (ref.status === 'deleted') {
        return {
          attachmentId: ref.attachmentId,
          name: ref.name,
          status: ref.status,
          mimeType: ref.mimeType,
          kind: 'unavailable' as const,
        };
      }

      if (IMAGE_MIME.has(ref.mimeType)) {
        const supportsVision = await modelSupportsVision(context.requestContext as RequestContext);
        if (!supportsVision) {
          throw new Error('当前模型不支持图片，请切换支持图片的模型后再读取该附件');
        }
        const maxBytes = maxFileSizeBytes();
        if (data.byteLength > maxBytes) {
          throw new Error(
            `图片 ${ref.name} 超过模型可读上限（${maxBytes} 字节 / 10 MiB），请压缩后再读取；选择或引用该文件仍可用`,
          );
        }
        return {
          attachmentId: ref.attachmentId,
          name: ref.name,
          status: ref.status,
          mimeType: ref.mimeType,
          kind: 'image' as const,
          imageBase64: data.toString('base64'),
        };
      }

      if (!isTextMime(ref.mimeType, ref.name)) {
        throw new Error(`附件 ${ref.name} 是二进制文件，不能按文本读取`);
      }

      const { content, truncated } = truncateUtf8(data, TEXT_BYTE_LIMIT);
      return {
        attachmentId: ref.attachmentId,
        name: ref.name,
        status: ref.status,
        mimeType: ref.mimeType,
        kind: 'text' as const,
        content,
        truncated,
      };
    },
    toModelOutput: (output: AttachedFileToolResult) => {
      if (output.kind === 'image' && output.imageBase64) {
        // Persistable shape only — raw bytes are injected for the current LLM call via
        // attachmentPersistenceProcessor.processLLMRequest (not written to messageList/OM).
        return {
          type: 'content',
          value: [
            {
              type: 'text',
              text: `附件 ${output.name}（${output.attachmentId}），状态 ${output.status}\n${workspaceAttachmentRefText(output)}`,
            },
          ],
        };
      }
      if (output.kind === 'text') {
        const note = output.truncated ? '\n\n[内容已截断至 64KiB]' : '';
        return {
          type: 'text',
          value: `附件 ${output.name}（${output.attachmentId}），状态 ${output.status}\n\n${output.content ?? ''}${note}`,
        };
      }
      return {
        type: 'json',
        value: toDisplay(output),
      };
    },
    transform: {
      display: {
        output: ({ output }) => toDisplay(output as AttachedFileToolResult),
        error: () => ({ message: '读取附件失败' }),
      },
      transcript: {
        output: ({ output }) => toDisplay(output as AttachedFileToolResult),
        error: () => ({ message: '读取附件失败' }),
      },
    },
  });
}

export const read_attached_file = createReadAttachedFileTool();

export const userFileTools = {
  read_file: createTool({
    id: 'read_file',
    description: '读取当前会话工作目录中的文件，path 为相对路径。',
    inputSchema: pathInput,
    execute: async (input, context) => {
      const auth = trustedAuth(context.requestContext);
      const service = await serviceFrom(context);
      const { data, name, etag, size } = await service.read(auth, agentThreadId(context), input.path);
      return { path: input.path, name, content: data.toString('utf8'), etag, size };
    },
  }),
  write_file: createTool({
    id: 'write_file',
    description: '写入当前会话工作目录中的文件，path 为相对路径，不要输出宿主 file: URL。',
    inputSchema: pathInput.extend({ content: z.string() }),
    execute: async (input, context) => {
      const auth = trustedAuth(context.requestContext);
      const service = await serviceFrom(context);
      const threadId = agentThreadId(context);
      const requestContext = context.requestContext!;
      bindSkillThreadId(requestContext, threadId);
      const writeOnce = async (mutationToken?: import('./artifacts/mutation-coordinator').WorkspaceMutationToken) => {
        await service.write(auth, threadId, input.path, Buffer.from(input.content), {
          signal: context?.abortSignal,
          mutationToken,
        });
      };
      if (readBoundServerExecutionId(requestContext)) {
        const artifactPath = normalizeArtifactPath({ scope: 'thread', threadId, path: input.path });
        const operationId = context?.agent?.toolCallId || randomUUID();
        const runContext = resolveArtifactRunContext(requestContext);
        if (runContext.identity.threadId !== threadId) {
          throw new Error('Tool threadId does not match bound artifact thread');
        }
        await withTrackedMutation(runContext, operationId, async (token) => writeOnce(token), {
          signal: context?.abortSignal,
          paths: [artifactPath],
        });
      } else {
        await writeOnce();
      }
      const current = await service.read(auth, threadId, input.path);
      recordWrittenFile(context.requestContext, input.path, current.etag, () => service.read(auth, threadId, input.path));
      return { path: `/user-files/${threadId}/${input.path}` };
    },
  }),
  list_files: createTool({
    id: 'list_files',
    description: '列出当前会话工作目录中的文件。',
    inputSchema: z.object({}),
    execute: async (_input, context) => {
      const auth = trustedAuth(context.requestContext);
      const service = await serviceFrom(context);
      return { files: await service.list(auth, agentThreadId(context)) };
    },
  }),
  delete_file: createTool({
    id: 'delete_file',
    description: '删除当前会话工作目录中的文件。',
    inputSchema: pathInput,
    execute: async (input, context) => {
      const auth = trustedAuth(context.requestContext);
      const service = await serviceFrom(context);
      await service.delete(auth, agentThreadId(context), input.path);
      return { ok: true, path: input.path };
    },
  }),
  glob: createTool({
    id: 'glob',
    description:
      '在当前会话目录（默认）或个人工作区中按 glob 模式查找普通文件。仅支持 * ? **；返回相对路径与 size，可能因预算截断。',
    inputSchema: z.object({
      pattern: z.string().min(1).describe('glob 模式，仅 * ? **'),
      scope: scopeInput.describe('thread 为默认会话目录；workspace 为个人工作区'),
      basePath: z.string().optional().describe('相对 scope 根的搜索起点，默认根目录'),
    }),
    execute: async (input, context) => {
      const auth = trustedAuth(context.requestContext);
      const threadId = agentThreadId(context);
      const scope = fileToolScope(input.scope);
      const lookup = await threadLookupFrom(context);
      const root = await resolveFileToolRoot(auth, threadId, lookup, scope);
      return globFiles({
        root,
        scope,
        threadId,
        basePath: input.basePath,
        pattern: input.pattern,
        signal: context?.abortSignal,
      });
    },
  }),
  grep: createTool({
    id: 'grep',
    description:
      '在当前会话目录（默认）或个人工作区中按字面文本搜索。默认大小写敏感；filePattern 默认 **/*。返回行号、截断后的行与 ETag，可能因预算截断。',
    inputSchema: z.object({
      query: z.string().min(1).describe('非空字面查询，最长 256 个 Unicode 字符'),
      scope: scopeInput.describe('thread 为默认会话目录；workspace 为个人工作区'),
      basePath: z.string().optional().describe('相对 scope 根的搜索起点，默认根目录'),
      filePattern: z.string().optional().describe('限制扫描文件的 glob，默认 **/*'),
      caseSensitive: z.boolean().optional().describe('默认 true；false 时忽略大小写'),
    }),
    execute: async (input, context) => {
      const auth = trustedAuth(context.requestContext);
      const threadId = agentThreadId(context);
      const scope = fileToolScope(input.scope);
      const lookup = await threadLookupFrom(context);
      const root = await resolveFileToolRoot(auth, threadId, lookup, scope);
      return grepFiles({
        root,
        scope,
        threadId,
        basePath: input.basePath,
        filePattern: input.filePattern,
        query: input.query,
        caseSensitive: input.caseSensitive,
        signal: context?.abortSignal,
      });
    },
  }),
  edit: createTool({
    id: 'edit',
    description:
      '对已存在的 UTF-8 文本文件做一次版本校验的精确替换。oldText 须在文件中恰好出现一次（含重叠）；expectedEtag 来自 read_file 或 grep。冲突时重新读取，勿盲目重试。',
    inputSchema: z.object({
      path: z.string().min(1).describe('相对 scope 根的已存在文件路径'),
      oldText: z.string().min(1).describe('非空原文，最长 64 KiB'),
      newText: z.string().describe('替换文本，可为空白，最长 64 KiB'),
      expectedEtag: z.string().min(1).describe('带引号的 SHA-256 ETag'),
      scope: scopeInput.describe('thread 为默认会话目录；workspace 为个人工作区'),
    }),
    execute: async (input, context) => {
      const auth = trustedAuth(context.requestContext);
      const threadId = agentThreadId(context);
      const scope = fileToolScope(input.scope);
      const lookup = await threadLookupFrom(context);
      const root = await resolveFileToolRoot(auth, threadId, lookup, scope);
      const relativePath = relativeFilePath(input.path);
      await resolveScopedPath(root, relativePath, scope, threadId);
      const filesystem = new LocalFilesystem({ basePath: root, contained: true });
      const requestContext = context.requestContext!;
      bindSkillThreadId(requestContext, threadId);
      const editOnce = (mutationToken?: WorkspaceMutationToken) => replaceWorkspaceText(
        filesystem,
        relativePath,
        input.oldText,
        input.newText,
        input.expectedEtag,
        auth.userId,
        { mutationToken, signal: context?.abortSignal },
      );
      const { etag, size } = readBoundServerExecutionId(requestContext)
        ? await withTrackedMutation(
          resolveArtifactRunContext(requestContext),
          context?.agent?.toolCallId || randomUUID(),
          async (token) => editOnce(token),
          {
            signal: context?.abortSignal,
            paths: [normalizeArtifactPath({ scope, threadId, path: relativePath })],
          },
        )
        : await editOnce();
      return {
        path: relativePath,
        etag,
        size,
        applicationPath: encodeApplicationPath(scope, threadId, relativePath),
        replacements: 1 as const,
      };
    },
  }),
  read_attached_file,
};
