import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { trustedAuth } from '../auth/auth-context';
import type { ThreadLookup } from '../auth/thread-guard';
import type { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import { findAuthorizedModel } from '../models/service';
import { resolveSelectedModel, trustedUserFrom } from '../models/resolver';
import { AttachmentService, type AttachmentStatus } from './attachments';
import { maxFileSizeBytes } from './policy';
import { FileService } from './service';

const pathInput = z.object({ path: z.string().min(1) });
const TEXT_BYTE_LIMIT = 64 * 1024;
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|yaml|x-yaml|toml|csv|sql))/i;

function agentThreadId(context: { agent?: { threadId?: string } }): string {
  const threadId = context.agent?.threadId;
  if (!threadId) throw new Error('Agent thread is required for file operations');
  return threadId;
}

function serviceFrom(context: { mastra?: unknown; requestContext?: unknown }) {
  if (!context.mastra || !context.requestContext) throw new Error('Authentication is required');
  return (context.mastra as Mastra).getAgent('agent')
    .getMemory({ requestContext: context.requestContext as RequestContext })
    .then(memory => {
      if (!memory) throw new Error('Agent memory is unavailable');
      return new FileService(memory as ThreadLookup);
    });
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
  return record.supportsVision === true;
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
      if (ref.status === 'deleted' || data.byteLength === 0 && ref.status === 'deleted') {
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
      const { data, name } = await service.read(auth, agentThreadId(context), input.path);
      return { path: input.path, name, content: data.toString('utf8') };
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
      await service.write(auth, threadId, input.path, Buffer.from(input.content));
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
  read_attached_file,
};
