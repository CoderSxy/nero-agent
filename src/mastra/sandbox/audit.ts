export function commandAuditSummary(input: {
  userId: string;
  threadId: string;
  sandboxId: string;
  command: string;
  cwd: string;
  exitCode: number;
  timedOut?: boolean;
  durationMs: number;
}): Record<string, unknown> {
  return {
    userId: input.userId,
    threadId: input.threadId,
    sandboxId: input.sandboxId,
    command: input.command.slice(0, 80),
    cwd: input.cwd,
    exitCode: input.exitCode,
    timedOut: Boolean(input.timedOut),
    durationMs: input.durationMs,
  };
}
