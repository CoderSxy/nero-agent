import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { trustedAuth } from '../auth/auth-context';
import type { ThreadLookup } from '../auth/thread-guard';
import { isSandboxCommandsEnabled } from '../workspace/config';
import { sandboxProvider } from './factory';
import { SandboxManager } from './manager';

const commandInput = z.object({
  threadId: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});

function memoryLookup(context: {
  mastra?: { getAgent(id: string): { getMemory(args: { requestContext: unknown }): Promise<ThreadLookup> } };
  requestContext?: unknown;
}): Promise<ThreadLookup> {
  if (!context.mastra || !context.requestContext) throw new Error('Authentication is required');
  return context.mastra.getAgent('agent').getMemory({ requestContext: context.requestContext });
}

export function createExecuteCommandTool(managerFactory?: (lookup: ThreadLookup) => SandboxManager) {
  return createTool({
    id: 'execute_command',
    description: '在当前会话工作目录中执行已批准的命令。不要传入 userId 或 cwd。',
    inputSchema: commandInput,
    execute: async (input, context) => {
      const auth = trustedAuth(context.requestContext);
      const lookup = await memoryLookup(context);
      const manager = managerFactory?.(lookup) ?? new SandboxManager(await sandboxProvider(), lookup);
      const result = await manager.execute({
        auth,
        threadId: input.threadId,
        command: input.command,
        args: input.args ?? [],
        abortSignal: context.abortSignal,
      });
      return result;
    },
  });
}

export const executeCommandTool = createExecuteCommandTool();

export function sandboxTools() {
  return isSandboxCommandsEnabled() ? { execute_command: executeCommandTool } : {};
}
