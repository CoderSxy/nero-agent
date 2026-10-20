import type { Processor } from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';
import { isAgentSkillsEnabled } from './config';
import {
  readBoundServerExecutionId,
  readBoundSkillThreadId,
  readSelectedSkillIds,
  resolveSkillExecution,
} from './execution-context';
import type { SkillRepository } from './repository';
import type { SkillService } from './service';
import type {
  SkillActivationEvent,
  SkillExecutionContext,
  SkillSummary,
} from './types';
import {
  NERO_AVAILABLE_SKILLS_TAG,
  NERO_LOADED_SKILLS_TAG,
  SKILL_ACTIVATION_CHUNK_TYPE,
  SKILL_LIMITS,
} from './validation';

export type SkillProcessorDeps = {
  service: SkillService;
  repository: SkillRepository;
};

type LoadedInstruction = {
  skillId: string;
  name: string;
  version: number;
  manifestHash: string;
  instructions: string;
};

type ProcessorSkillState = {
  serverExecutionId?: string;
  threadId?: string;
  selectedLoaded?: boolean;
  activations?: SkillActivationEvent[];
  loadedInstructions?: LoadedInstruction[];
  catalogInjected?: boolean;
  activationKeys?: Set<string>;
  contextLimitError?: string;
};

/** Tool loads normalize into the same activation summary as processor explicit loads. */
const activationsByRequest = new WeakMap<object, SkillActivationEvent[]>();
const activationKeysByRequest = new WeakMap<object, Set<string>>();

function skillState(state: Record<string, unknown>): ProcessorSkillState {
  const existing = state.neroSkills as ProcessorSkillState | undefined;
  if (existing) {
    if (!existing.activationKeys) existing.activationKeys = new Set();
    if (!existing.activations) existing.activations = [];
    if (!existing.loadedInstructions) existing.loadedInstructions = [];
    return existing;
  }
  const created: ProcessorSkillState = {
    activations: [],
    loadedInstructions: [],
    activationKeys: new Set(),
  };
  state.neroSkills = created;
  return created;
}

function activationKey(event: SkillActivationEvent): string {
  return [
    event.serverExecutionId,
    event.skillId,
    event.version ?? '',
    event.status,
  ].join('/');
}

function sharedActivationStore(requestContext: RequestContext | undefined): {
  list: SkillActivationEvent[];
  keys: Set<string>;
} | null {
  if (!requestContext) return null;
  let list = activationsByRequest.get(requestContext);
  let keys = activationKeysByRequest.get(requestContext);
  if (!list) {
    list = [];
    activationsByRequest.set(requestContext, list);
  }
  if (!keys) {
    keys = new Set();
    activationKeysByRequest.set(requestContext, keys);
  }
  return { list, keys };
}

function recordActivation(
  skill: ProcessorSkillState,
  event: SkillActivationEvent,
  writer?: { custom: (chunk: { type: string; data: unknown }) => Promise<void> },
  requestContext?: RequestContext,
): void {
  const key = activationKey(event);
  if (skill.activationKeys!.has(key)) {
    // Still allow shared store merge for tools that race processor.
  } else {
    skill.activationKeys!.add(key);
    skill.activations!.push(event);
  }

  const shared = sharedActivationStore(requestContext);
  if (shared && !shared.keys.has(key)) {
    shared.keys.add(key);
    shared.list.push(event);
  }

  void writer?.custom({
    type: SKILL_ACTIVATION_CHUNK_TYPE,
    data: event,
  }).catch(() => undefined);
}

function mergeSharedActivations(
  skill: ProcessorSkillState,
  requestContext: RequestContext | undefined,
): SkillActivationEvent[] {
  const shared = sharedActivationStore(requestContext);
  if (shared) {
    for (const event of shared.list) {
      const key = activationKey(event);
      if (skill.activationKeys!.has(key)) continue;
      skill.activationKeys!.add(key);
      skill.activations!.push(event);
    }
  }
  return skill.activations ?? [];
}

type PromptMessage = {
  role: string;
  content: unknown;
};

function stripTaggedBlocks<T extends PromptMessage>(prompt: T[], tag: string): T[] {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  return prompt.filter((message) => {
    if (message.role !== 'system') return true;
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((p: { text?: unknown }) => String(p?.text ?? '')).join('')
        : '';
    return !(content.includes(open) && content.includes(close));
  });
}

function formatCatalog(items: SkillSummary[]): string {
  const lines = items.map(
    (s) =>
      `- ${s.name}: ${s.description.slice(0, 200)} [${s.availability}] v${s.version}`,
  );
  let body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > SKILL_LIMITS.CATALOG_MAX_BYTES) {
    while (
      lines.length > 0
      && Buffer.byteLength(lines.join('\n'), 'utf8') > SKILL_LIMITS.CATALOG_MAX_BYTES
    ) {
      lines.pop();
    }
    body = `${lines.join('\n')}\n… catalog truncated; use skill_search to discover more.`;
  }
  return `<${NERO_AVAILABLE_SKILLS_TAG}>\n${body}\n</${NERO_AVAILABLE_SKILLS_TAG}>`;
}

function formatLoadedInstructions(loaded: LoadedInstruction[]): string {
  const parts = loaded.map(
    (item) =>
      `### ${item.name} (v${item.version})\n${item.instructions}`,
  );
  return `<${NERO_LOADED_SKILLS_TAG}>\n${parts.join('\n\n')}\n</${NERO_LOADED_SKILLS_TAG}>`;
}

function instructionsBudgetOk(loaded: LoadedInstruction[]): boolean {
  const text = formatLoadedInstructions(loaded);
  return Buffer.byteLength(text, 'utf8') <= SKILL_LIMITS.INSTRUCTIONS_CONTEXT_MAX_BYTES;
}

function stampAssistantMetadata(
  messageList: {
    get?: { response?: { db?: () => Array<{ role: string; content: { metadata?: Record<string, unknown> } }> } };
  } | undefined,
  activations: SkillActivationEvent[],
): void {
  if (!messageList?.get?.response?.db || activations.length === 0) return;
  const messages = messageList.get.response.db();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant') continue;
    const metadata = { ...(msg.content.metadata ?? {}) };
    metadata.neroSkillActivations = activations.map((a) => ({ ...a }));
    msg.content.metadata = metadata;
    break;
  }
}

async function loadSelectedSkills(
  deps: SkillProcessorDeps,
  ctx: SkillExecutionContext,
  selectedIds: string[],
  skill: ProcessorSkillState,
  writer?: { custom: (chunk: { type: string; data: unknown }) => Promise<void> },
  requestContext?: RequestContext,
): Promise<void> {
  for (const skillId of selectedIds) {
    const result = await deps.service.loadById(ctx, skillId);
    if (result.ok) {
      const entry: LoadedInstruction = {
        skillId: result.skill.skillId,
        name: result.skill.name,
        version: result.skill.version,
        manifestHash: result.skill.manifestHash,
        instructions: result.data.instructions,
      };
      const next = [...(skill.loadedInstructions ?? []), entry];
      if (!instructionsBudgetOk(next)) {
        skill.contextLimitError = 'SKILL_CONTEXT_LIMIT';
        recordActivation(skill, {
          serverExecutionId: ctx.serverExecutionId,
          skillId,
          name: result.skill.name,
          status: 'failed',
          errorCode: 'SKILL_CONTEXT_LIMIT',
        }, writer, requestContext);
        continue;
      }
      skill.loadedInstructions = next;
      recordActivation(skill, {
        serverExecutionId: ctx.serverExecutionId,
        skillId: result.skill.skillId,
        name: result.skill.name,
        version: result.skill.version,
        manifestHash: result.skill.manifestHash,
        status: 'loaded',
      }, writer, requestContext);
    } else {
      recordActivation(skill, {
        serverExecutionId: ctx.serverExecutionId,
        skillId,
        name: skillId,
        status: 'failed',
        errorCode: result.code,
      }, writer, requestContext);
    }
  }
}

function resolveTrustedThreadId(
  args: { threadId?: string },
  messageList: { get?: { all?: { db?: () => Array<{ threadId?: string }> } } } | undefined,
  requestContext: RequestContext,
): string | null {
  const fromArgs = typeof args.threadId === 'string' && args.threadId.trim() && args.threadId.trim() !== 'no-thread'
    ? args.threadId.trim()
    : null;
  const fromMessages = messageList?.get?.all?.db?.()?.find((m) => m.threadId)?.threadId;
  const fromMsg = typeof fromMessages === 'string' && fromMessages.trim() && fromMessages !== 'no-thread'
    ? fromMessages.trim()
    : null;
  return fromArgs ?? fromMsg ?? readBoundSkillThreadId(requestContext);
}

/**
 * Injects available-skill catalog + explicitly selected instructions.
 * Uses processInputStep.runId or WeakMap-bound server execution id — never client string keys.
 */
export function createSkillProcessor(deps: SkillProcessorDeps) {
  return {
    id: 'nero-agent-skills',

    async processInputStep(args) {
      const {
        runId,
        state,
        requestContext,
        writer,
        messageList,
      } = args as typeof args & { runId?: string; threadId?: string };
      if (!isAgentSkillsEnabled()) return;
      if (!requestContext) return;

      const skill = skillState(state);
      // Prefer Mastra args.runId → prior processor state → WeakMap bind.
      // Never trust client-writable requestContext string keys; never randomUUID() a pin id.
      const serverExecutionId =
        (typeof runId === 'string' && runId.trim() ? runId.trim() : null)
        ?? skill.serverExecutionId
        ?? readBoundServerExecutionId(requestContext);

      if (!serverExecutionId) {
        // Fail closed: production paths must call bindSkillServerExecutionId / prepareSkillRunOptions.
        return;
      }

      const threadId = resolveTrustedThreadId(
        args as { threadId?: string },
        messageList as never,
        requestContext,
      );
      if (!threadId) {
        // Fail closed for authenticated skill work without a real thread.
        return;
      }

      try {
        const ctx = await resolveSkillExecution({
          requestContext,
          serverExecutionId,
          threadId,
          repository: deps.repository,
        });
        skill.serverExecutionId = ctx.serverExecutionId;
        skill.threadId = ctx.threadId;

        // stepNumber stays >0 across approval resume, and processor state is not the pin store.
        // Load selected skills once per execution state so compression/resume does not drop bodies.
        if (!skill.selectedLoaded) {
          const selected = readSelectedSkillIds(requestContext);
          if (selected.length > 0) {
            await loadSelectedSkills(deps, ctx, selected, skill, writer, requestContext);
          }
          skill.selectedLoaded = true;
        }
      } catch {
        // Unauthenticated or missing thread — do not inject catalog.
      }
    },

    async processLLMRequest({ prompt, state, requestContext, stepNumber }) {
      if (!isAgentSkillsEnabled()) return;
      const skill = skillState(state);
      if (!requestContext) return;
      const serverExecutionId = readBoundServerExecutionId(requestContext) ?? skill.serverExecutionId;
      const threadId = readBoundSkillThreadId(requestContext) ?? skill.threadId;
      if (!serverExecutionId || !threadId) return;

      let authOk = true;
      let ctx: SkillExecutionContext | null = null;
      try {
        ctx = await resolveSkillExecution({
          requestContext,
          serverExecutionId,
          threadId,
          repository: deps.repository,
        });
      } catch {
        authOk = false;
      }
      if (!authOk || !ctx) {
        return { prompt: stripTaggedBlocks(stripTaggedBlocks(prompt, NERO_AVAILABLE_SKILLS_TAG), NERO_LOADED_SKILLS_TAG) };
      }

      // A search can pin many candidates without activating their instructions.
      // Restore only successful loads (durable load events survive a new RequestContext).
      const activations = mergeSharedActivations(skill, requestContext);
      const loadedIds = new Set([
        ...(ctx.loadedSkillIds ?? []),
        ...(skill.loadedInstructions ?? []).map(item => item.skillId),
        ...activations.filter(event => event.serverExecutionId === serverExecutionId && event.status === 'loaded')
          .map(event => event.skillId),
      ]);
      const kept: LoadedInstruction[] = [];
      skill.contextLimitError = undefined;
      for (const pin of [...ctx.pins.values()]) {
        if (!loadedIds.has(pin.skillId)) continue;
        const reloaded = await deps.service.loadById(ctx, pin.skillId);
        if (!reloaded.ok
          || reloaded.skill.version !== pin.version
          || reloaded.skill.manifestHash !== pin.manifestHash) continue;
        const entry: LoadedInstruction = {
          ...reloaded.skill,
          instructions: reloaded.data.instructions,
        };
        if (!instructionsBudgetOk([...kept, entry])) {
          skill.contextLimitError = 'SKILL_CONTEXT_LIMIT';
          recordActivation(skill, {
            serverExecutionId, skillId: pin.skillId, name: pin.name,
            status: 'failed', errorCode: 'SKILL_CONTEXT_LIMIT',
          }, undefined, requestContext);
          continue;
        }
        kept.push(entry);
        recordActivation(skill, {
          serverExecutionId, ...reloaded.skill, status: 'loaded',
        }, undefined, requestContext);
      }
      skill.loadedInstructions = kept;

      let nextPrompt = stripTaggedBlocks(prompt, NERO_AVAILABLE_SKILLS_TAG);
      nextPrompt = stripTaggedBlocks(nextPrompt, NERO_LOADED_SKILLS_TAG);

      const catalogPage = await deps.service.listAvailable(ctx.auth, {
        page: 1,
        pageSize: SKILL_LIMITS.CATALOG_MAX_ITEMS,
      });
      const catalogText = formatCatalog(catalogPage.items.slice(0, SKILL_LIMITS.CATALOG_MAX_ITEMS));

      const systemParts: Array<{ role: 'system'; content: string }> = [
        { role: 'system', content: catalogText },
      ];
      skill.catalogInjected = true;

      if (skill.contextLimitError) {
        systemParts.push({
          role: 'system',
          content: `<${NERO_LOADED_SKILLS_TAG}>\nERROR SKILL_CONTEXT_LIMIT: loaded skill instructions exceed 128KiB budget.\n</${NERO_LOADED_SKILLS_TAG}>`,
        });
      } else if ((skill.loadedInstructions?.length ?? 0) > 0) {
        if (!instructionsBudgetOk(skill.loadedInstructions!)) {
          skill.contextLimitError = 'SKILL_CONTEXT_LIMIT';
          systemParts.push({
            role: 'system',
            content: `<${NERO_LOADED_SKILLS_TAG}>\nERROR SKILL_CONTEXT_LIMIT: loaded skill instructions exceed 128KiB budget.\n</${NERO_LOADED_SKILLS_TAG}>`,
          });
        } else {
          systemParts.push({
            role: 'system',
            content: formatLoadedInstructions(skill.loadedInstructions!),
          });
        }
      }

      // Failures must be visible to the model on the first request.
      const failed = (skill.activations ?? []).filter((a) => a.status === 'failed');
      if (failed.length > 0 && stepNumber === 0) {
        systemParts.push({
          role: 'system',
          content:
            `<nero_skill_activation_errors>\n`
            + failed.map((f) => `- ${f.name}: ${f.errorCode ?? 'failed'}`).join('\n')
            + `\n</nero_skill_activation_errors>`,
        });
      }

      return { prompt: [...systemParts, ...nextPrompt] };
    },

    processOutputResult({ state, messageList, requestContext }) {
      if (!isAgentSkillsEnabled()) return messageList;
      const skill = skillState(state);
      const activations = mergeSharedActivations(skill, requestContext as RequestContext | undefined);
      stampAssistantMetadata(messageList as never, activations);
      return messageList;
    },
  } satisfies Processor;
}

/**
 * Record a tool-driven activation into shared + optional processor state.
 * Prefer passing requestContext so factory-wired tools normalize into the same summary.
 */
export function noteToolActivation(
  state: Record<string, unknown> | undefined,
  event: SkillActivationEvent,
  requestContext?: RequestContext,
  writer?: { custom: (chunk: { type: string; data: unknown }) => Promise<void> },
): void {
  if (state) {
    recordActivation(skillState(state), event, writer, requestContext);
    return;
  }
  if (!requestContext) return;
  const shared = sharedActivationStore(requestContext);
  if (!shared) return;
  const key = activationKey(event);
  if (shared.keys.has(key)) return;
  shared.keys.add(key);
  shared.list.push(event);
  void writer?.custom({
    type: SKILL_ACTIVATION_CHUNK_TYPE,
    data: event,
  }).catch(() => undefined);
}

/** Test helper: read activations recorded for a requestContext (processor + tools). */
export function listSharedActivations(requestContext: RequestContext): SkillActivationEvent[] {
  return (activationsByRequest.get(requestContext) ?? []).map((a) => ({ ...a }));
}
