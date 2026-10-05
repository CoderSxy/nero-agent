import type { SandboxCommandResult, SandboxExecuteOptions, SandboxInspect, SandboxOwner } from './types';

export interface SandboxProvider {
  ensureRunning(owner: SandboxOwner, workspaceRoot: string): Promise<SandboxInspect>;
  execute(
    owner: SandboxOwner,
    command: string,
    args: string[],
    options: SandboxExecuteOptions,
  ): Promise<SandboxCommandResult>;
  stop(owner: SandboxOwner): Promise<void>;
  remove(owner: SandboxOwner): Promise<void>;
  inspect(owner: SandboxOwner): Promise<SandboxInspect>;
}
