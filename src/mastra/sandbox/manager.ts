import { randomUUID } from 'node:crypto';
import { prepareTaskRuntime } from './task-runtime';
import { sandboxNetworkManager } from './network/manager';
import { getSandboxRuntimeConfig } from './runtime-config';
import type { ThreadLookup } from '../auth/thread-guard';
import { assertThreadOwned } from '../auth/thread-guard';
import { isSandboxCommandsEnabled, sandboxCommandTimeoutMs } from '../workspace/config';
import { ensureThreadDirectory, ensureUserWorkspace } from '../workspace/manager';
import { assertHostQuotaReady } from '../workspace/disk-protection';
import {
  resolveArtifactRunContext,
  withManualWorkspaceMutation,
  withTrackedMutation,
} from '../files/artifacts/collector';
import { bindSkillThreadId, readBoundServerExecutionId } from '../skills/execution-context';
import { commandQueue } from './execution-queue';
import { commandAuditSummary } from './audit';
import type { SandboxProvider } from './provider';
import { sandboxIdFor, type ExecutionRequest, type SandboxCommandResult, type SandboxOwner } from './types';
import type { RequestContext } from '@mastra/core/request-context';

export class SandboxManager {
  constructor(
    private readonly provider: SandboxProvider,
    private readonly lookup: ThreadLookup,
  ) {}

  ownerFor(userId: string): SandboxOwner {
    return { userId, sandboxId: sandboxIdFor(userId) };
  }

  async executeBash(
    request: Pick<ExecutionRequest, 'auth' | 'threadId' | 'abortSignal' | 'requestContext' | 'operationId'> & {
      script: string;
    },
  ): Promise<SandboxCommandResult> {
    if (!getSandboxRuntimeConfig().bashEnabled) throw new Error('Bash execution is disabled');
    if (!request.script || request.script.includes('\0') || Buffer.byteLength(request.script, 'utf8') > 65536) {
      throw new Error('Invalid Bash script (maximum 64KiB)');
    }
    return this.execute({ ...request, command: 'bash', args: ['--noprofile', '--norc', '-c', request.script] });
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
        const runCommand = async () => {
          await this.provider.ensureRunning(owner, root);
          const config = getSandboxRuntimeConfig();
          const runtime = (config.bashEnabled || config.dependenciesEnabled || config.networkMode === 'public-http')
            ? await prepareTaskRuntime({
              execute: (cmd, args, opts) => this.provider.execute(owner, cmd, args, opts),
              cwd: containerPath,
              imageDigest: process.env.SANDBOX_IMAGE ?? '',
              dependenciesEnabled: config.dependenciesEnabled,
              proxyUrl: config.networkMode === 'public-http'
                ? (await (await sandboxNetworkManager()).ensure(owner)).proxyUrl
                : undefined,
              abortSignal: request.abortSignal,
            })
            : undefined;
          const started = Date.now();
          const result = await this.provider.execute(owner, request.command, request.args, {
            cwd: containerPath,
            env: runtime?.env,
            timeoutMs: sandboxCommandTimeoutMs(),
            abortSignal: request.abortSignal,
          });
          if (runtime?.warnings.length) {
            result.stderr = [...runtime.warnings, result.stderr].filter(Boolean).join('\n');
          }
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
        };

        // Mutation lock is acquired INSIDE the commandQueue slot (never re-enter the queue).
        const requestContext = request.requestContext as RequestContext | undefined;
        if (requestContext) bindSkillThreadId(requestContext, request.threadId);
        const operationId = request.operationId || randomUUID();
        if (requestContext && readBoundServerExecutionId(requestContext)) {
          const runContext = resolveArtifactRunContext(requestContext);
          if (runContext.identity.threadId !== request.threadId) {
            throw new Error('Sandbox threadId does not match bound artifact thread');
          }
          return withTrackedMutation(runContext, operationId, async () => runCommand(), {
            signal: request.abortSignal,
            afterBudget: { maxFiles: 5_000, maxBytes: 512 * 1024 * 1024, maxMs: 5_000 },
          });
        }
        return withManualWorkspaceMutation(request.auth, async () => runCommand(), {
          signal: request.abortSignal,
        });
      },
      request.abortSignal,
    );
  }
}
