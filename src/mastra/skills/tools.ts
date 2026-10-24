import { createTool } from '@mastra/core/tools';
import { noteToolActivation } from './processor';
import type { ToolsInput } from '@mastra/core/agent';
import { z } from 'zod';
import { trustedAuth } from '../auth/auth-context';
import type { ThreadLookup } from '../auth/thread-guard';
import { isAgentSkillsEnabled, isSkillScriptExecutionEnabled } from './config';
import {
  readBoundServerExecutionId,
  readBoundSkillThreadId,
  resolveSkillExecution,
} from './execution-context';
import type { SkillRepository } from './repository';
import type { SkillService } from './service';
import type { SkillScriptRunner } from './script-runner';
import { SKILL_SCRIPT_LIMITS } from './script-runner';
import type { SkillActivationEvent, SkillExecutionContext, SkillResult } from './types';
import { SKILL_LIMITS } from './validation';
import type { RequestContext } from '@mastra/core/request-context';

export type SkillToolsDeps = {
  service: SkillService;
  repository: SkillRepository;
  /** Optional hook so processor/UI can unify tool loads into activation summaries. */
  onActivation?: (event: SkillActivationEvent, requestContext: RequestContext) => void;
  /** Test/direct runner. When set (and switches on), exposes run_skill_script. */
  scriptRunner?: SkillScriptRunner;
  /** Production: build a runner with a real ThreadLookup. */
  createScriptRunner?: (lookup: ThreadLookup) => SkillScriptRunner | Promise<SkillScriptRunner>;
  resolveThreadLookup?: (context: {
    mastra?: unknown;
    requestContext?: unknown;
  }) => Promise<ThreadLookup>;
};

function stripHostPaths(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (/^\/Users\/|^\/home\/|^[A-Za-z]:\\|^file:/.test(value)) return '[redacted-path]';
    return value;
  }
  if (Array.isArray(value)) return value.map(stripHostPaths);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'hostPath' || k === 'releaseRoot' || k === 'cwd') continue;
      out[k] = stripHostPaths(v);
    }
    return out;
  }
  return value;
}

function toolResultEnvelope<T>(result: SkillResult<T>): Record<string, unknown> {
  if (!result.ok) {
    return stripHostPaths({ ok: false, code: result.code, message: result.message }) as Record<
      string,
      unknown
    >;
  }
  return stripHostPaths({
    ok: true,
    skill: result.skill,
    data: result.data,
  }) as Record<string, unknown>;
}

async function executionFromToolContext(
  deps: SkillToolsDeps,
  context: {
    requestContext?: unknown;
    agent?: { threadId?: string };
  },
): Promise<{ ctx: SkillExecutionContext; requestContext: RequestContext }> {
  const requestContext = context.requestContext as RequestContext;
  if (!requestContext) throw new Error('Authentication is required');
  trustedAuth(requestContext);

  const serverExecutionId = readBoundServerExecutionId(requestContext);
  if (!serverExecutionId) {
    throw new Error('Skill execution context is not ready');
  }
  const threadId =
    readBoundSkillThreadId(requestContext)
    ?? (typeof context.agent?.threadId === 'string'
      && context.agent.threadId.trim()
      && context.agent.threadId !== 'no-thread'
      ? context.agent.threadId.trim()
      : null);
  if (!threadId) {
    throw new Error('Skill thread context is not ready');
  }

  const ctx = await resolveSkillExecution({
    requestContext,
    serverExecutionId,
    threadId,
    repository: deps.repository,
  });
  return { ctx, requestContext };
}

function emitActivation(
  deps: SkillToolsDeps,
  ctx: SkillExecutionContext,
  requestContext: RequestContext,
  result: SkillResult<unknown>,
  nameHint: string,
): void {
  const event: SkillActivationEvent = result.ok ? {
    serverExecutionId: ctx.serverExecutionId,
    skillId: result.skill.skillId,
    name: result.skill.name,
    version: result.skill.version,
    manifestHash: result.skill.manifestHash,
    status: 'loaded',
  } : {
    serverExecutionId: ctx.serverExecutionId,
    skillId: '', name: nameHint, status: 'failed', errorCode: result.code,
  };
  noteToolActivation(undefined, event, requestContext);
  deps.onActivation?.(event, requestContext);
}

/**
 * Application skill tools. Do NOT register alongside native Agent.skills auto-tools.
 */
export function createSkillTools(deps: SkillToolsDeps): ToolsInput {
  if (!isAgentSkillsEnabled()) return {};

  const skill = createTool({
    id: 'skill',
    description:
      'Load an authorized published skill by exact canonical name or alias. Returns instructions and a virtual skill:// baseUri — never host paths.',
    inputSchema: z.object({
      name: z.string().min(1).max(SKILL_LIMITS.CANONICAL_NAME_MAX),
    }),
    execute: async (input, context) => {
      const { ctx, requestContext } = await executionFromToolContext(deps, context);
      const result = await deps.service.load(ctx, input.name);
      emitActivation(deps, ctx, requestContext, result, input.name);
      return toolResultEnvelope(result);
    },
  });

  const skill_read = createTool({
    id: 'skill_read',
    description:
      'Read a text resource from a pinned skill version. Binary resources return RESOURCE_BINARY with an authorized download API path.',
    inputSchema: z.object({
      skillName: z.string().min(1).max(SKILL_LIMITS.CANONICAL_NAME_MAX),
      path: z.string().min(1).max(SKILL_LIMITS.PATH_MAX_CHARS),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
    }),
    execute: async (input, context) => {
      const { ctx } = await executionFromToolContext(deps, context);
      const result = await deps.service.read(ctx, input);
      return toolResultEnvelope(result);
    },
  });

  const skill_search = createTool({
    id: 'skill_search',
    description:
      'Search authorized published skill instructions and text resources using space-separated keywords (matches any keyword). Results include canonical skill names: pass that exact name to skill to load instructions. Pins versions on first hit.',
    inputSchema: z.object({
      query: z.string().min(SKILL_LIMITS.SEARCH_QUERY_MIN).max(SKILL_LIMITS.SEARCH_QUERY_MAX),
      skillNames: z.array(z.string().min(1)).max(20).optional(),
      topK: z.number().int().min(1).max(SKILL_LIMITS.SEARCH_TOPK_MAX).optional(),
    }),
    execute: async (input, context) => {
      const { ctx } = await executionFromToolContext(deps, context);
      const result = await deps.service.search(ctx, input);
      return toolResultEnvelope(result);
    },
  });

  const tools: ToolsInput = { skill, skill_read, skill_search };

  const scriptEnabled =
    isSkillScriptExecutionEnabled()
    && (deps.scriptRunner != null || deps.createScriptRunner != null);

  if (scriptEnabled) {
    const run_skill_script = createTool({
      id: 'run_skill_script',
      description:
        'Run an allowed entrypoint under scripts/ for a pinned skill inside an isolated container with its declared network policy and task dependencies. Pass path + args only — never hostPath, cwd, image, or shell strings.',
      inputSchema: z.object({
        skillName: z.string().min(1).max(SKILL_LIMITS.CANONICAL_NAME_MAX),
        path: z.string().min(1).max(SKILL_LIMITS.PATH_MAX_CHARS),
        args: z
          .array(z.string().max(SKILL_SCRIPT_LIMITS.MAX_ARG_CHARS))
          .max(SKILL_SCRIPT_LIMITS.MAX_ARGS)
          .optional(),
      }),
      execute: async (input, context) => {
        const { ctx } = await executionFromToolContext(deps, context);
        let runner = deps.scriptRunner;
        if (!runner && deps.createScriptRunner) {
          if (!deps.resolveThreadLookup) {
            return toolResultEnvelope({
              ok: false,
              code: 'RUNTIME_UNAVAILABLE',
              message: 'Skill script thread lookup is unavailable',
            });
          }
          const lookup = await deps.resolveThreadLookup(context);
          runner = await deps.createScriptRunner(lookup);
        }
        if (!runner) {
          return toolResultEnvelope({
            ok: false,
            code: 'RUNTIME_UNAVAILABLE',
            message: 'Skill script execution is unavailable',
          });
        }
        const result = await runner.execute(
          ctx,
          {
            skillName: input.skillName,
            path: input.path,
            args: input.args,
          },
          context.abortSignal,
        );
        return toolResultEnvelope(result);
      },
    });
    const prepare_skill_resources=createTool({
      id:'prepare_skill_resources',
      description:'Copy an authorized pinned skill into the current task for Bash use. Returns a container path; never a host path. Copy is writable, published original is immutable. Re-prepare restores original content.',
      inputSchema:z.object({skillName:z.string().min(1).max(SKILL_LIMITS.CANONICAL_NAME_MAX)}),
      execute:async(input,context)=>{
        const {ctx}=await executionFromToolContext(deps,context);
        const runner=deps.scriptRunner??(deps.createScriptRunner&&deps.resolveThreadLookup?await deps.createScriptRunner(await deps.resolveThreadLookup(context)):undefined);
        if(!runner?.prepareResources)return toolResultEnvelope({ok:false,code:'RUNTIME_UNAVAILABLE',message:'Skill resources unavailable'});
        return toolResultEnvelope(await runner.prepareResources(ctx,input.skillName,context.abortSignal));
      },
    });
    return { ...tools, run_skill_script, prepare_skill_resources } as ToolsInput;
  }

  return tools;
}
