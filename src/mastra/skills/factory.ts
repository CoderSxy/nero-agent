import { getPool } from '../auth/db';
import type { ThreadLookup } from '../auth/thread-guard';
import type { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import { createDockerodeEngine } from '../sandbox/docker/client';
import { createBlobStore } from './blob-store';
import {
  getSkillsStorageRoot,
  isAgentSkillsEnabled,
  isSkillScriptExecutionEnabled,
  skillScriptImageDigest,
} from './config';
import { createSkillProcessor, noteToolActivation } from './processor';
import { createReleaseStore, type ReleaseStore } from './release-store';
import { createSkillRepository, type SkillRepository } from './repository';
import { createSkillService, type SkillService } from './service';
import { createSkillScriptResolve } from './script-resolve';
import { createSkillScriptRunner, type SkillScriptRunner } from './script-runner';
import { createSkillTools } from './tools';
import { createSkillVersionService } from './versions';
import type { ToolsInput } from '@mastra/core/agent';
import type { Processor } from '@mastra/core/processors';
import type { SkillActivationEvent } from './types';

export type SkillRuntimeBundle = {
  service: SkillService;
  repository: SkillRepository;
  releaseStore: ReleaseStore;
  tools: ToolsInput;
  processor: ReturnType<typeof createSkillProcessor>;
};

let cached: SkillRuntimeBundle | null = null;
let enginePromise: ReturnType<typeof createDockerodeEngine> | undefined;

async function memoryLookup(context: {
  mastra?: unknown;
  requestContext?: unknown;
}): Promise<ThreadLookup> {
  if (!context.mastra || !context.requestContext) throw new Error('Authentication is required');
  const memory = await (context.mastra as Mastra).getAgent('agent')
    .getMemory({ requestContext: context.requestContext as RequestContext });
  if (!memory) throw new Error('Agent memory is unavailable');
  return memory as ThreadLookup;
}

function buildScriptRunner(
  bundle: Pick<SkillRuntimeBundle, 'service' | 'repository' | 'releaseStore'>,
  lookup: ThreadLookup,
): SkillScriptRunner {
  const imageDigest = skillScriptImageDigest();
  enginePromise ??= createDockerodeEngine();
  // createSkillScriptRunner needs a sync engine; wrap with lazy proxy.
  const lazyEngine = {
    create: async (options: Parameters<Awaited<ReturnType<typeof createDockerodeEngine>>['create']>[0]) =>
      (await enginePromise!).create(options),
    start: async (id: string) => (await enginePromise!).start(id),
    inspect: async (id: string) => (await enginePromise!).inspect(id),
    findLabeled: async (label: string, value: string) => (await enginePromise!).findLabeled(label, value),
    exec: async (
      id: string,
      command: string,
      args: string[],
      options: Parameters<Awaited<ReturnType<typeof createDockerodeEngine>>['exec']>[3],
    ) => (await enginePromise!).exec(id, command, args, options),
    stop: async (id: string) => (await enginePromise!).stop(id),
    remove: async (id: string, force?: boolean) => (await enginePromise!).remove(id, force),
  };
  return createSkillScriptRunner({
    engine: lazyEngine,
    lookup,
    resolve: createSkillScriptResolve(bundle),
    imageDigest,
  });
}

/**
 * Lazy singleton for Agent wiring. When AGENT_SKILLS_ENABLED is false, tools/processor
 * are inert no-ops (empty tools; processor early-returns).
 */
export function getSkillRuntime(): SkillRuntimeBundle {
  if (cached) return cached;

  // Validate explicit storage configuration before opening any other runtime dependency.
  const root = getSkillsStorageRoot();
  const pool = getPool();
  const repository = createSkillRepository(pool);
  const blobStore = createBlobStore({ root });
  const releaseStore = createReleaseStore({ root, blobStore });
  const versionService = createSkillVersionService({ repository, blobStore, releaseStore, pool });
  const service = createSkillService({ repository, blobStore, releaseStore, versionService, pool });

  const processor = createSkillProcessor({ service, repository });
  const onActivation = (event: SkillActivationEvent, requestContext: RequestContext) => {
    noteToolActivation(undefined, event, requestContext);
  };

  const tools = createSkillTools({
    service,
    repository,
    onActivation,
    createScriptRunner: isSkillScriptExecutionEnabled()
      ? async (lookup) => buildScriptRunner({ service, repository, releaseStore }, lookup)
      : undefined,
    resolveThreadLookup: memoryLookup,
  });

  cached = { service, repository, releaseStore, tools, processor };
  return cached;
}

/** Test helper: reset singleton between cases. */
export function resetSkillRuntimeForTests(): void {
  cached = null;
  enginePromise = undefined;
}

export function resolveSkillAgentTools(): ToolsInput {
  if (!isAgentSkillsEnabled()) return {};
  const runtime = getSkillRuntime();
  // Recreate so mid-test env flips are observed.
  return createSkillTools({
    service: runtime.service,
    repository: runtime.repository,
    onActivation: (event, requestContext) => {
      noteToolActivation(undefined, event, requestContext);
    },
    createScriptRunner: isSkillScriptExecutionEnabled()
      ? async (lookup) => buildScriptRunner(runtime, lookup)
      : undefined,
    resolveThreadLookup: memoryLookup,
  });
}

/**
 * Lazy processor facade so importing agent.ts does not require skills storage
 * until the first enabled request actually runs processor methods.
 */
export function resolveSkillAgentProcessor() {
  return {
    id: 'nero-agent-skills',
    async processInputStep(args) {
      if (!isAgentSkillsEnabled()) return;
      return getSkillRuntime().processor.processInputStep(args);
    },
    async processLLMRequest(args) {
      if (!isAgentSkillsEnabled()) return;
      return getSkillRuntime().processor.processLLMRequest(args);
    },
    processOutputResult(args) {
      if (!isAgentSkillsEnabled()) return args.messageList;
      return getSkillRuntime().processor.processOutputResult(args);
    },
  } satisfies Processor;
}
