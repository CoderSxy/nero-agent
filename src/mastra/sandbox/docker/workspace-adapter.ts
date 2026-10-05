import type { CommandResult, ExecuteCommandOptions, SandboxInfo, WorkspaceSandbox } from '@mastra/core/workspace';
import type { SandboxManager } from '../manager';
import type { ExecutionRequest } from '../types';

export class ManagedWorkspaceSandbox implements WorkspaceSandbox {
  readonly id = 'managed-sandbox';
  readonly name = 'Managed Sandbox';
  readonly provider = 'managed';
  status: SandboxInfo['status'] = 'pending';

  constructor(
    private readonly manager: SandboxManager,
    private readonly request: Pick<ExecutionRequest, 'auth' | 'threadId'>,
  ) {}

  async snapshot(): Promise<void> {}

  async executeCommand(command: string, args: string[] = [], options?: ExecuteCommandOptions): Promise<CommandResult> {
    const started = Date.now();
    const result = await this.manager.execute({
      auth: this.request.auth,
      threadId: this.request.threadId,
      command,
      args,
      abortSignal: options?.abortSignal,
    });
    this.status = 'running';
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      executionTimeMs: Date.now() - started,
      timedOut: result.timedOut,
      command,
      args,
    };
  }

  async getInfo(): Promise<SandboxInfo> {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      createdAt: new Date(),
    };
  }
}
