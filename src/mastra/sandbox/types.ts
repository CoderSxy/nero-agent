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
  /** When present and bound to a server run, command mutations are attributed. */
  requestContext?: import('@mastra/core/request-context').RequestContext;
  operationId?: string;
};

export type SandboxInspect = {
  sandboxId: string;
  status: 'missing' | 'created' | 'running' | 'stopped';
  workspaceRoot?: string;
};

export type SandboxExecuteOptions = {
  env?: string[];
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
