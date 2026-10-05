import type { AuthContext } from '../auth/auth-context';

export type SandboxOwner = {
  userId: string;
  sandboxId: string;
};

export type ExecutionRequest = {
  auth: AuthContext;
  threadId: string;
  command: string;
  args: string[];
  abortSignal?: AbortSignal;
};

export type SandboxInspect = {
  sandboxId: string;
  status: 'missing' | 'created' | 'running' | 'stopped';
  workspaceRoot?: string;
};

export type SandboxExecuteOptions = {
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
};

export type SandboxCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export function sandboxIdFor(userId: string): string {
  return `sb_${userId}`;
}
