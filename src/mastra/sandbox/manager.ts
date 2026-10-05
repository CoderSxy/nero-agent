import type { ThreadLookup } from '../auth/thread-guard';
import { assertThreadOwned } from '../auth/thread-guard';
import { isSandboxCommandsEnabled, sandboxCommandTimeoutMs } from '../workspace/config';
import { ensureThreadDirectory, ensureUserWorkspace } from '../workspace/manager';
import { assertHostQuotaReady } from '../workspace/disk-protection';
import { commandQueue } from './execution-queue';
import { commandAuditSummary } from './audit';
import type { SandboxProvider } from './provider';
import { sandboxIdFor, type ExecutionRequest, type SandboxCommandResult, type SandboxOwner } from './types';

export class SandboxManager {
  constructor(
    private readonly provider: SandboxProvider,
    private readonly lookup: ThreadLookup,
  ) {}

  ownerFor(userId: string): SandboxOwner {
    return { userId, sandboxId: sandboxIdFor(userId) };
  }

  async execute(request: ExecutionRequest): Promise<SandboxCommandResult> {
    if (!isSandboxCommandsEnabled()) {
      throw new Error('Sandbox commands are disabled');
    }
    assertHostQuotaReady();
    if (!request.threadId) {
      throw new Error('threadId is required');
    }
    await assertThreadOwned(request.auth, request.threadId, this.lookup);
    const { containerPath } = await ensureThreadDirectory(request.auth, request.threadId, this.lookup);
    const root = await ensureUserWorkspace(request.auth);
    const owner = this.ownerFor(request.auth.userId);
    return commandQueue.run(
      request.auth.userId,
      request.threadId,
      async () => {
        await this.provider.ensureRunning(owner, root);
        const started = Date.now();
        const result = await this.provider.execute(owner, request.command, request.args, {
          cwd: containerPath,
          timeoutMs: sandboxCommandTimeoutMs(),
          abortSignal: request.abortSignal,
        });
        commandAuditSummary({
          userId: request.auth.userId,
          threadId: request.threadId,
          sandboxId: owner.sandboxId,
          command: request.command,
          cwd: containerPath,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: Date.now() - started,
        });
        return result;
      },
      request.abortSignal,
    );
  }
}
