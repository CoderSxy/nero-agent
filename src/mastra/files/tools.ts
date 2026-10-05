import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { trustedAuth } from '../auth/auth-context';
import type { ThreadLookup } from '../auth/thread-guard';
import { FileService } from './service';

const pathInput = z.object({
  threadId: z.string().min(1),
  path: z.string().min(1),
});

function serviceFrom(context: { mastra?: { getAgent(id: string): { getMemory(args: { requestContext: unknown }): Promise<ThreadLookup> } }; requestContext?: unknown }) {
  if (!context.mastra || !context.requestContext) throw new Error('Authentication is required');
  return context.mastra.getAgent('agent').getMemory({ requestContext: context.requestContext })
    .then(memory => new FileService(memory));
}

export const userFileTools = {
  read_file: createTool({
    id: 'read_file',
    description: '读取当前会话工作目录中的文件，path 为相对路径。',
    inputSchema: pathInput,
    execute: async (input, context) => {
      const auth = trustedAuth(context.requestContext);
      const service = await serviceFrom(context);
      const { data, name } = await service.read(auth, input.threadId, input.path);
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
      await service.write(auth, input.threadId, input.path, Buffer.from(input.content));
      return { path: `/api/user-files/${input.threadId}/${input.path}` };
    },
  }),
  list_files: createTool({
    id: 'list_files',
    description: '列出当前会话工作目录中的文件。',
    inputSchema: z.object({ threadId: z.string().min(1) }),
    execute: async (input, context) => {
      const auth = trustedAuth(context.requestContext);
      const service = await serviceFrom(context);
      return { files: await service.list(auth, input.threadId) };
    },
  }),
  delete_file: createTool({
    id: 'delete_file',
    description: '删除当前会话工作目录中的文件。',
    inputSchema: pathInput,
    execute: async (input, context) => {
      const auth = trustedAuth(context.requestContext);
      const service = await serviceFrom(context);
      await service.delete(auth, input.threadId, input.path);
      return { ok: true, path: input.path };
    },
  }),
};
