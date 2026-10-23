import type { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { resolveArtifactRunContext } from '../files/artifacts/collector';
import { settleArtifactRun, startArtifactRun } from '../files/artifacts/lifecycle';
import { prepareSkillRunOptions } from './execution-context';

type AnyFn = (...args: never[]) => unknown;

async function noteSuspendedIfNeeded(
  requestContext: RequestContext | undefined,
  result: { finishReason?: string } | undefined,
): Promise<void> {
  if (!requestContext || result?.finishReason !== 'suspended') return;
  try {
    const ctx = resolveArtifactRunContext(requestContext);
    await settleArtifactRun(ctx, { state: 'suspended' });
  } catch (error) {
    console.error('artifact suspend settle failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function noteResumeStart(requestContext: RequestContext | undefined): Promise<void> {
  if (!requestContext) return;
  try {
    const ctx = resolveArtifactRunContext(requestContext);
    await startArtifactRun(ctx);
  } catch (error) {
    console.error('artifact resume start failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Wrap production Agent entrypoints so chat / stream / resume always bind a
 * server-owned runId (WeakMap) before processors/tools pin.
 */
export function installSkillExecutionBindings(agent: Agent): void {
  const mutable = agent as unknown as Record<string, AnyFn>;

  const wrapStart = (method: string) => {
    const original = mutable[method];
    if (typeof original !== 'function') return;
    mutable[method] = ((messages: never, options?: never) => {
      const prepared = prepareSkillRunOptions(options as never, 'start') as {
        requestContext: RequestContext;
        runId: string;
      };
      const result = original.call(agent, messages, prepared as never);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<{ finishReason?: string }>).then(async (value) => {
          await noteSuspendedIfNeeded(prepared.requestContext, value);
          return value;
        });
      }
      return result;
    }) as AnyFn;
  };

  const wrapResume = (method: string) => {
    const original = mutable[method];
    if (typeof original !== 'function') return;
    mutable[method] = ((resumeData: never, options?: never) => {
      const prepared = prepareSkillRunOptions(options as never, 'resume') as {
        requestContext: RequestContext;
        runId: string;
      };
      const kicked = noteResumeStart(prepared.requestContext);
      const result = original.call(agent, resumeData, prepared as never);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return Promise.resolve(kicked).then(() => result as Promise<unknown>).then(async (value) => {
          await noteSuspendedIfNeeded(
            prepared.requestContext,
            value as { finishReason?: string },
          );
          return value;
        });
      }
      return result;
    }) as AnyFn;
  };

  wrapStart('generate');
  wrapStart('stream');
  wrapStart('streamUntilIdle');
  wrapResume('resumeGenerate');
  wrapResume('resumeStream');
  wrapResume('resumeStreamUntilIdle');

  const originalSendMessage = mutable.sendMessage;
  if (typeof originalSendMessage === 'function') {
    mutable.sendMessage = ((messages: never, options?: never) => {
      const opts = { ...((options as Record<string, unknown> | undefined) ?? {}) };
      const ifIdle = { ...((opts.ifIdle as Record<string, unknown> | undefined) ?? {}) };
      const streamOptionsIn = (ifIdle.streamOptions as Record<string, unknown> | undefined) ?? {};
      const threadId =
        (typeof opts.threadId === 'string' ? opts.threadId : undefined)
        ?? (typeof streamOptionsIn.threadId === 'string' ? streamOptionsIn.threadId : undefined);
      const memory = streamOptionsIn.memory
        ?? (threadId
          ? {
              thread: threadId,
              resource: typeof opts.resourceId === 'string' ? opts.resourceId : undefined,
            }
          : undefined);
      const prepared = prepareSkillRunOptions(
        {
          ...streamOptionsIn,
          memory,
          threadId,
        },
        'start',
      );
      ifIdle.streamOptions = prepared;
      opts.ifIdle = ifIdle;
      return originalSendMessage.call(agent, messages, opts as never);
    }) as AnyFn;
  }
}
