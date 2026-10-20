import type { Agent } from '@mastra/core/agent';
import { prepareSkillRunOptions } from './execution-context';

type AnyFn = (...args: never[]) => unknown;

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
      const prepared = prepareSkillRunOptions(options as never, 'start');
      return original.call(agent, messages, prepared);
    }) as AnyFn;
  };

  const wrapResume = (method: string) => {
    const original = mutable[method];
    if (typeof original !== 'function') return;
    mutable[method] = ((resumeData: never, options?: never) => {
      const prepared = prepareSkillRunOptions(options as never, 'resume');
      return original.call(agent, resumeData, prepared);
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
