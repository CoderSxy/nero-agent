import type { SandboxProvider } from './provider';
import type { SandboxCommandResult, SandboxExecuteOptions, SandboxInspect, SandboxOwner } from './types';

export class FakeSandboxProvider implements SandboxProvider {
  ensureRunningCalls = 0;
  executeCalls = 0;
  lastOwner?: SandboxOwner;
  lastWorkspaceRoot?: string;
  lastCommand?: string;
  lastArgs?: string[];
  lastOptions?: SandboxExecuteOptions;

  async ensureRunning(owner: SandboxOwner, workspaceRoot: string): Promise<SandboxInspect> {
    this.ensureRunningCalls += 1;
    this.lastOwner = owner;
    this.lastWorkspaceRoot = workspaceRoot;
    return { sandboxId: owner.sandboxId, status: 'running', workspaceRoot };
  }

  async execute(
    owner: SandboxOwner,
    command: string,
    args: string[],
    options: SandboxExecuteOptions,
  ): Promise<SandboxCommandResult> {
    this.executeCalls += 1;
    this.lastOwner = owner;
    this.lastCommand = command;
    this.lastArgs = args;
    this.lastOptions = options;
    return {
      exitCode: 0,
      stdout: `${command} ${args.join(' ')}`.trim(),
      stderr: '',
    };
  }

  async stop(): Promise<void> {}
  async remove(): Promise<void> {}

  async inspect(owner: SandboxOwner): Promise<SandboxInspect> {
    return { sandboxId: owner.sandboxId, status: this.ensureRunningCalls > 0 ? 'running' : 'missing' };
  }
}
