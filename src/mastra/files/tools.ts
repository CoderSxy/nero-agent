import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { trustedAuth } from '../auth/auth-context';
import type { ThreadLookup } from '../auth/thread-guard';
import type { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import { FileService } from './service';

const pathInput = z.object({ path: z.string().min(1) });

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
};
