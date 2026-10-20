/**
 * Task 14 D-gate: long-session compression, approval resume, scheduled run,
 * and disabled-skill history. Reuses the Task 5 execution probe.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { MockStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  bindSkillThreadId,
  prepareSkillRunOptions,
} from '../src/mastra/skills/execution-context.ts';
import { createSkillTools } from '../src/mastra/skills/tools.ts';
import { createSkillProcessor } from '../src/mastra/skills/processor.ts';
import type { SkillRepository } from '../src/mastra/skills/repository.ts';
import type {
  SkillActivation,
  SkillPin,
  SkillRunPinRecord,
  SkillService,
  SkillSummary,
} from '../src/mastra/skills/types.ts';
import { SELECTED_SKILL_IDS_CONTEXT_KEY } from '../src/mastra/skills/validation.ts';
import { runSkillsExecutionProbe } from './skills-execution-probe.test.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SKILL_ID = '22222222-2222-4222-8222-222222222222';
const DISABLED_ID = '33333333-3333-4333-8333-333333333333';
const HASH_V1 = 'a'.repeat(64);
const HASH_V2 = 'b'.repeat(64);
const THREAD = 'thread-long-conversation';

type Store = Map<string, SkillRunPinRecord>;

function pinKey(serverExecutionId: string): string {
  return serverExecutionId;
}

function createHarness() {
  const store: Store = new Map();
  let publishedVersion = 1;
  const repository = {
    async listRunPins(input: { serverExecutionId: string; userId: string; threadId: string }) {
      const row = store.get(pinKey(input.serverExecutionId));
      if (!row) return [];
      if (row.userId !== input.userId || row.threadId !== input.threadId) return [];
      if (new Date(row.expiresAt).getTime() <= Date.now()) return [];
      return [row];
    },
    async touchRunPins(input: { serverExecutionId: string }) {
      const row = store.get(pinKey(input.serverExecutionId));
      if (!row) return;
      row.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    },
  } as unknown as SkillRepository;

  function remember(ctx: { serverExecutionId: string; userId: string; threadId: string }, pin: SkillPin) {
    store.set(pinKey(ctx.serverExecutionId), {
      ...pin,
      serverExecutionId: ctx.serverExecutionId,
      userId: ctx.userId,
      threadId: ctx.threadId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  function activation(pin: SkillPin): { ok: true; skill: SkillPin; data: SkillActivation } {
    return {
      ok: true,
      skill: pin,
      data: {
        instructions: pin.version === 1 ? 'PINNED_BODY_V1' : 'BODY_V2',
        baseUri: 'skill://demo',
        description: 'demo',
        resources: [],
        hasMoreResources: false,
        availability: 'instructions-only',
      },
    };
  }

  const service = {
    async listAvailable(): Promise<{ items: SkillSummary[]; total: number; page: number; pageSize: number }> {
      return {
        items: [{
          id: SKILL_ID,
          name: 'demo',
          description: 'catalog-demo',
          version: publishedVersion,
          userInvocable: true,
          availability: 'instructions-only',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
      };
    },
    async loadById(ctx: { serverExecutionId: string; userId: string; threadId: string; pins: Map<string, SkillPin> }, skillId: string) {
      if (skillId === DISABLED_ID) {
        return { ok: false as const, code: 'SKILL_UNAVAILABLE', message: 'disabled' };
      }
      const existing = ctx.pins.get(skillId) ?? store.get(pinKey(ctx.serverExecutionId));
      const version = existing?.version ?? publishedVersion;
      const pin: SkillPin = {
        skillId,
        name: 'demo',
        version,
        manifestHash: version === 1 ? HASH_V1 : HASH_V2,
      };
      ctx.pins.set(skillId, pin);
      remember({ ...ctx, userId: (ctx as unknown as { auth: { userId: string } }).auth.userId }, pin);
      return activation(pin);
    },
    async load(ctx: { serverExecutionId: string; userId: string; threadId: string; pins: Map<string, SkillPin> }, _name: string) {
      return service.loadById(ctx, SKILL_ID);
    },
  } as unknown as SkillService;

  return {
    repository,
    service,
    store,
    setPublishedVersion(version: number) {
      publishedVersion = version;
    },
  };
}

function user(): { id: string; email: string; displayName: string; roles: ['user'] } {
  return {
    id: USER_ID,
    email: 'long@example.test',
    displayName: 'Long',
    roles: ['user'],
  };
}

function countTag(text: string, tag: string): number {
  const open = `<${tag}>`;
  return text.split(open).length - 1;
}

function extractMessages(body: unknown): string {
  return JSON.stringify((body as { messages?: unknown })?.messages ?? body);
}

function createModel(name: string, handler: (call: number, body: unknown) => Response) {
  let call = 0;
  return createOpenAICompatible({
    name,
    baseURL: 'https://example.test/v1',
    apiKey: 'test',
    fetch: async (_url, init) => {
      call += 1;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      return handler(call, body);
    },
  }).chatModel('test');
}

function textResponse(content: string) {
  return Response.json({
    id: 'test',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function toolCallResponse(toolName: string, toolCallId: string, args: Record<string, unknown>) {
  return Response.json({
    id: 'test',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

test('Task 5 execution probe still shares state only inside one generate and keeps resume runId', async () => {
  const result = await runSkillsExecutionProbe();
  assert.equal(result.sharedAcrossThreeModelSteps, true);
  assert.equal(result.sharedAcrossSecondUserTurn, false);
  assert.notEqual(result.firstRunId, result.secondRunId);
  assert.equal(result.resumePreservesRunId, true);
});

test('long conversation: compression does not duplicate or drop skill body, and does not swap the pin', async () => {
  const previous = process.env.AGENT_SKILLS_ENABLED;
  process.env.AGENT_SKILLS_ENABLED = 'true';
  const harness = createHarness();
  const captured: string[] = [];
  try {
    const replay = {
      id: 'history-replay',
      processLLMRequest({ prompt }: { prompt: Array<{ role?: string; content?: unknown }> }) {
        const ghost = {
          role: 'system',
          content: '<nero_loaded_skills>\n### demo (v1)\nPINNED_BODY_V1\n</nero_loaded_skills>',
        };
        const ghostCatalog = {
          role: 'system',
          content: '<nero_available_skills>\n- demo: stale\n</nero_available_skills>',
        };
        return { prompt: [ghost, ghost, ghostCatalog, ...prompt] };
      },
    };
    const processor = createSkillProcessor({ service: harness.service, repository: harness.repository });
    const noop = createTool({
      id: 'noop',
      description: 'step',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const model = createModel('skills-long-compress', (call, body) => {
      const text = extractMessages(body);
      captured.push(text);
      if (call === 1) {
        harness.setPublishedVersion(2);
        return toolCallResponse('noop', 'noop-1', {});
      }
      return textResponse('compressed-ok');
    });
    const agent = new Agent({
      id: 'skills-long-compress',
      name: 'skills-long-compress',
      model,
      tools: { noop },
      inputProcessors: [replay, processor],
      defaultOptions: { maxSteps: 4 },
    });
    const requestContext = new RequestContext();
    requestContext.set('mastra__user', user());
    requestContext.set(SELECTED_SKILL_IDS_CONTEXT_KEY, [SKILL_ID, DISABLED_ID]);
    bindSkillThreadId(requestContext, THREAD);
    const result = await agent.generate('USER_ORIGINAL_BODY', prepareSkillRunOptions({
      requestContext,
      threadId: THREAD,
    }, 'start'));
    assert.equal(result.text, 'compressed-ok');
    assert.ok(captured.length >= 2);
    for (const text of captured) {
      assert.equal(countTag(text, 'nero_loaded_skills'), 1, text);
      assert.equal(countTag(text, 'nero_available_skills'), 1, text);
      assert.equal(text.split('PINNED_BODY_V1').length - 1, 1);
      assert.equal(text.includes('BODY_V2'), false);
      assert.equal(text.includes('DISABLED_INSTRUCTION_BODY'), false);
      assert.equal(text.includes('USER_ORIGINAL_BODY'), true);
    }
    const row = [...harness.store.values()][0];
    assert.equal(row?.version, 1);
    assert.equal(row?.manifestHash, HASH_V1);
  } finally {
    if (previous === undefined) delete process.env.AGENT_SKILLS_ENABLED;
    else process.env.AGENT_SKILLS_ENABLED = previous;
  }
});

test('approval resume keeps runId and pinned skill version', async () => {
  const previous = process.env.AGENT_SKILLS_ENABLED;
  process.env.AGENT_SKILLS_ENABLED = 'true';
  const harness = createHarness();
  const captured: string[] = [];
  try {
    const processor = createSkillProcessor({ service: harness.service, repository: harness.repository });
    const gate = createTool({
      id: 'gate',
      description: 'approval gate',
      inputSchema: z.object({ x: z.string() }),
      suspendSchema: z.object({ reason: z.string() }),
      resumeSchema: z.object({ answer: z.string() }),
      execute: async (input, ctx) => {
        if (!(ctx.agent?.resumeData ?? ctx.resumeData)) {
          await ctx.agent!.suspend({ reason: 'need-user' });
          return { ok: false };
        }
        return { ok: true, x: input.x };
      },
    });
    let call = 0;
    const model = createModel('skills-long-resume', (_call, body) => {
      call += 1;
      captured.push(extractMessages(body));
      if (call === 1) return toolCallResponse('gate', 'gate-1', { x: 'hi' });
      return textResponse('resumed-ok');
    });
    const agent = new Agent({
      id: 'skills-long-resume',
      name: 'skills-long-resume',
      model,
      tools: { gate },
      inputProcessors: [processor],
      defaultOptions: { maxSteps: 4 },
    });
    new Mastra({
      agents: { 'skills-long-resume': agent },
      storage: new MockStore(),
    });
    const requestContext = new RequestContext();
    requestContext.set('mastra__user', user());
    requestContext.set(SELECTED_SKILL_IDS_CONTEXT_KEY, [SKILL_ID]);
    bindSkillThreadId(requestContext, THREAD);
    const started = prepareSkillRunOptions({ requestContext, threadId: THREAD }, 'start');
    const suspended = await agent.generate('USER_ORIGINAL_BODY', started);
    assert.equal(suspended.finishReason, 'suspended');
    harness.setPublishedVersion(2);
    const resumed = await agent.resumeGenerate(
      { answer: 'yes' },
      prepareSkillRunOptions({ requestContext, threadId: THREAD, runId: suspended.runId }, 'resume'),
    );
    assert.equal(resumed.runId, suspended.runId);
    assert.equal(resumed.runId, started.runId);
    assert.equal(resumed.text, 'resumed-ok');
    for (const [index, text] of captured.entries()) {
      assert.equal(text.includes('BODY_V2'), false, `call ${index} swapped pin`);
      assert.equal(text.includes('PINNED_BODY_V1'), true, `call ${index} dropped pinned body`);
    }
    assert.equal([...harness.store.values()][0]?.version, 1);
    assert.equal(captured.some((text) => text.includes('USER_ORIGINAL_BODY')), true);
  } finally {
    if (previous === undefined) delete process.env.AGENT_SKILLS_ENABLED;
    else process.env.AGENT_SKILLS_ENABLED = previous;
  }
});

test('scheduled execution pins the selected skill for the whole run and omits disabled instructions', async () => {
  const previous = process.env.AGENT_SKILLS_ENABLED;
  process.env.AGENT_SKILLS_ENABLED = 'true';
  const harness = createHarness();
  harness.setPublishedVersion(1);
  const captured: string[] = [];
  try {
    const processor = createSkillProcessor({ service: harness.service, repository: harness.repository });
    const noop = createTool({
      id: 'noop',
      description: 'step',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const model = createModel('skills-long-sched', (call, body) => {
      const text = extractMessages(body);
      captured.push(text);
      if (call === 1) {
        harness.setPublishedVersion(2);
        return toolCallResponse('noop', 'noop-1', {});
      }
      return textResponse('scheduled-ok');
    });
    const agent = new Agent({
      id: 'skills-long-sched',
      name: 'skills-long-sched',
      model,
      tools: { noop },
      inputProcessors: [processor],
      defaultOptions: { maxSteps: 4 },
    });
    const requestContext = new RequestContext();
    requestContext.set('mastra__user', user());
    requestContext.set(SELECTED_SKILL_IDS_CONTEXT_KEY, [SKILL_ID, DISABLED_ID, 'not-a-uuid']);
    const threadId = `sched-${randomUUID()}`;
    bindSkillThreadId(requestContext, threadId);
    const result = await agent.generate('SCHEDULED_USER_BODY', prepareSkillRunOptions({
      requestContext,
      threadId,
    }, 'start'));
    assert.equal(result.text, 'scheduled-ok');
    assert.equal(captured.length, 2);
    for (const text of captured) {
      assert.equal(countTag(text, 'nero_loaded_skills'), 1);
      assert.equal(text.includes('PINNED_BODY_V1'), true);
      assert.equal(text.includes('BODY_V2'), false);
      assert.equal(text.includes('DISABLED_INSTRUCTION_BODY'), false);
      assert.equal(text.includes('SCHEDULED_USER_BODY'), true);
    }
    assert.equal([...harness.store.values()][0]?.version, 1);
  } finally {
    if (previous === undefined) delete process.env.AGENT_SKILLS_ENABLED;
    else process.env.AGENT_SKILLS_ENABLED = previous;
  }
});


test('automatic tool load survives removal of tool history and empty processor state', async () => {
  const previous = process.env.AGENT_SKILLS_ENABLED;
  process.env.AGENT_SKILLS_ENABLED = 'true';
  try {
    const harness = createHarness();
    const captured: string[] = [];
    const processor = createSkillProcessor(harness);
    const compress = {
      id: 'remove-tool-history-and-state',
      processLLMRequest(args: { prompt: Array<{ role: string; content: unknown }>; state: Record<string, unknown> }) {
        // Model output and processor cache are disposable; server pins are durable.
        delete args.state.neroSkills;
        return { prompt: args.prompt.filter((m) => m.role === 'system' || m.role === 'user') };
      },
    };
    const model = createModel('automatic-load-compression', (call, body) => {
      captured.push(extractMessages(body));
      if (call === 1) return toolCallResponse('skill', 'auto-load', { name: 'demo' });
      harness.setPublishedVersion(2);
      return textResponse('automatic-ok');
    });
    const agent = new Agent({
      id: 'automatic-load-compression', name: 'automatic-load-compression', model,
      tools: createSkillTools(harness),
      inputProcessors: [compress, processor], defaultOptions: { maxSteps: 4 },
    });
    const requestContext = new RequestContext();
    requestContext.set('mastra__user', user());
    const result = await agent.generate('load demo', prepareSkillRunOptions({ requestContext, threadId: THREAD }, 'start'));
    assert.equal(result.text, 'automatic-ok');
    assert.ok(captured.length >= 2);
    assert.doesNotMatch(captured[0]!, /PINNED_BODY_V1/);
    assert.match(captured[1]!, /<nero_loaded_skills>/);
    assert.match(captured[1]!, /PINNED_BODY_V1/);
    assert.doesNotMatch(captured[1]!, /BODY_V2/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_SKILLS_ENABLED;
    else process.env.AGENT_SKILLS_ENABLED = previous;
  }
});
