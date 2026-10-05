import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { trustedAuth } from '../auth/auth-context';
import type { ThreadLookup } from '../auth/thread-guard';
import type { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import { isSandboxCommandsEnabled } from '../workspace/config';
import { sandboxProvider } from './factory';
import { SandboxManager } from './manager';

const commandInput = z.object({
  threadId: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});

async function memoryLookup(context: { mastra?: unknown; requestContext?: unknown }): Promise<ThreadLookup> {
  if (!context.mastra || !context.requestContext) throw new Error('Authentication is required');
  const memory = await (context.mastra as Mastra).getAgent('agent')
    .getMemory({ requestContext: context.requestContext as RequestContext });
  if (!memory) throw new Error('Agent memory is unavailable');
  return memory as ThreadLookup;
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
  return isSandboxCommandsEnabled()
    && process.env.SANDBOX_PROVIDER === 'docker'
    && process.env.WORKSPACE_HOST_QUOTA_VERIFIED === 'true'
    && process.env.SANDBOX_FILE_WRITE_ENABLED === 'true'
    ? { execute_command: executeCommandTool } : {};
}
