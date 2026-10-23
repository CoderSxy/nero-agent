import type { Processor } from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';
import {
  bindSkillServerExecutionId,
  bindSkillThreadId,
  readBoundServerExecutionId,
  readBoundSkillThreadId,
} from '../../skills/execution-context';
import { trustedAuth } from '../../auth/auth-context';
import {
  resolveArtifactRunContext,
  type ArtifactRunContext,
} from './collector';
import {
  finishReasonToArtifactState,
  settleArtifactRun,
  startArtifactRun,
} from './lifecycle';
import type { ArtifactRepository } from './repository';
import type { TurnArtifacts } from './types';

type ProcessorState = {
  artifactStarted?: boolean;
  artifactSettled?: boolean;
};

function tryResolveContext(requestContext: RequestContext | undefined, runId?: string): ArtifactRunContext | null {
  if (!requestContext) return null;
  try {
    if (runId && !readBoundServerExecutionId(requestContext)) {
      bindSkillServerExecutionId(requestContext, runId);
    }
    if (!readBoundSkillThreadId(requestContext)) {
      // Thread may only live on agent options; cannot invent it here.
      return null;
    }
    return resolveArtifactRunContext(requestContext);
  } catch {
    return null;
  }
}

function stampMetadata(
  messageList: {
    get: { response: { db: () => Array<{ id?: string; role: string; content: { metadata?: Record<string, unknown> } }> } };
  } | undefined,
  ref: { runId: string; threadId: string },
): string | null {
  if (!messageList?.get?.response?.db) return null;
  const messages = messageList.get.response.db();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant') continue;
    const metadata = { ...(msg.content.metadata ?? {}) };
    metadata.neroArtifactRun = { version: 1, runId: ref.runId, threadId: ref.threadId };
    msg.content.metadata = metadata;
    return typeof msg.id === 'string' ? msg.id : null;
  }
  return null;
}

export function createTurnArtifactsProcessor(deps: {
  repository?: ArtifactRepository;
  enabled?: () => boolean;
} = {}) {
  const repository = deps.repository;
  const enabled = deps.enabled ?? (() => Boolean(repository || process.env.DATABASE_URL));

  return {
    id: 'turn-artifacts',

    async processInputStep({ state, requestContext, runId, messageList }) {
      if (!enabled()) return;
      const quality = state as ProcessorState;
      if (quality.artifactStarted) return;
      const threadHint = readBoundSkillThreadId(requestContext as RequestContext | undefined);
      if (!threadHint && requestContext) {
        // Attempt to recover thread from memory message metadata when wrappers bound only runId.
        const msgs = messageList?.get?.all?.db?.() as Array<{ threadId?: string }> | undefined;
        const threadId = msgs?.find((m) => typeof m.threadId === 'string')?.threadId;
        if (threadId) bindSkillThreadId(requestContext as RequestContext, threadId);
      }
      const ctx = tryResolveContext(requestContext as RequestContext | undefined, runId);
      if (!ctx) return;
      try {
        trustedAuth(ctx.requestContext);
        await startArtifactRun(ctx, { repository });
        quality.artifactStarted = true;
      } catch (error) {
        console.error('artifact start failed', {
          runId: ctx.identity.runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async processOutputResult({ state, messageList, result, writer, requestContext, abortSignal }) {
      if (!enabled()) return messageList;
      const quality = state as ProcessorState;
      if (quality.artifactSettled) return messageList;

      const runId = (result as { runId?: string } | undefined)?.runId;
      const ctx = tryResolveContext(requestContext as RequestContext | undefined, runId);
      if (!ctx) return messageList;

      const finishReason = (result as { finishReason?: string } | undefined)?.finishReason;
      const artifactState = finishReasonToArtifactState(finishReason, abortSignal?.aborted);
      const anchorMessageId = stampMetadata(messageList, {
        runId: ctx.identity.runId,
        threadId: ctx.identity.threadId,
      });

      try {
        const settled = await settleArtifactRun(ctx, {
          state: artifactState,
          anchorMessageId,
        }, { repository });
        quality.artifactSettled = true;
        if (writer?.custom && shouldNotify(settled)) {
          await writer.custom({ type: 'data-nero-artifacts', data: settled });
        }
      } catch (error) {
        console.error('artifact settle failed', {
          runId: ctx.identity.runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return messageList;
    },
  } satisfies Processor;
}

function shouldNotify(value: TurnArtifacts): boolean {
  if (value.state === 'running' || value.state === 'suspended') return false;
  if (value.artifacts.length > 0) return true;
  return value.collectionStatus === 'partial';
}

export const turnArtifactsProcessor = createTurnArtifactsProcessor();
