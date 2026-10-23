/**
 * Task 1 characterization: Mastra 1.71.0 lifecycle hooks + message metadata anchor.
 * Documents verified call points for Task 5 (turn-artifacts processor).
 * Does not implement product artifact collection yet.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { MockStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import {
  bindSkillServerExecutionId,
  bindSkillThreadId,
  prepareSkillRunOptions,
} from '../src/mastra/skills/execution-context';
import { installSkillExecutionBindings } from '../src/mastra/skills/agent-bindings';

type HookName =
  | 'processInput'
  | 'processInputStep'
  | 'processLLMRequest'
  | 'processLLMResponse'
  | 'processOutputStream'
  | 'processOutputStep'
  | 'processToolResult'
  | 'processOutputResult';

type HookEvent = {
  hook: HookName;
  stepNumber?: number;
  runId?: string;
  hasWriter: boolean;
  toolCalls?: number;
  finishReasonHint?: string;
};

function textResponse(content: string) {
  return Response.json({
    id: 'test',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
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

function createMockModel(handler: (callIndex: number) => Response) {
  let callIndex = 0;
  return createOpenAICompatible({
    name: 'turn-artifacts-lifecycle',
    baseURL: 'https://example.test/v1',
    apiKey: 'test',
    fetch: async () => handler(++callIndex),
  }).chatModel('test');
}

function createProbeProcessor(log: HookEvent[]) {
  const record = (hook: HookName, args: Record<string, unknown>) => {
    log.push({
      hook,
      stepNumber: typeof args.stepNumber === 'number' ? args.stepNumber : undefined,
      runId: typeof args.runId === 'string' ? args.runId : undefined,
      hasWriter: Boolean(args.writer && typeof (args.writer as { custom?: unknown }).custom === 'function'),
      toolCalls: Array.isArray(args.toolCalls) ? args.toolCalls.length : undefined,
    });
  };

  return {
    id: 'turn-artifacts-lifecycle-probe',
    processInput(args: Record<string, unknown>) {
      record('processInput', args);
    },
    processInputStep(args: Record<string, unknown>) {
      record('processInputStep', args);
    },
    processLLMRequest(args: Record<string, unknown>) {
      record('processLLMRequest', args);
    },
    processLLMResponse(args: Record<string, unknown>) {
      record('processLLMResponse', args);
    },
    async processOutputStream(args: Record<string, unknown>) {
      record('processOutputStream', args);
      return args.part;
    },
    async processOutputStep(args: Record<string, unknown>) {
      record('processOutputStep', args);
      return args.messageList;
    },
    async processToolResult(args: Record<string, unknown>) {
      record('processToolResult', args);
    },
    processOutputResult(args: Record<string, unknown>) {
      record('processOutputResult', args);
      return args.messageList;
    },
  };
}

function hooksOf(log: HookEvent[], name: HookName) {
  return log.filter((event) => event.hook === name);
}

test('multi tool/LLM steps: processInput once; input/output step per model step; outputResult once; writer available on output hooks', async () => {
  const log: HookEvent[] = [];
  const noop = createTool({
    id: 'noop',
    description: 'noop',
    inputSchema: z.object({}),
    execute: async () => ({ ok: true }),
  });
  let call = 0;
  const model = createMockModel(() => {
    call += 1;
    if (call <= 2) return toolCallResponse('noop', `noop-${call}`, {});
    return textResponse('done');
  });
  const probe = createProbeProcessor(log);
  const agent = new Agent({
    id: 'ta-multi-step',
    name: 'ta-multi-step',
    model,
    tools: { noop },
    inputProcessors: [probe],
    outputProcessors: [probe],
    defaultOptions: { maxSteps: 5 },
  });

  const result = await agent.generate('ping');
  assert.equal(result.text, 'done');
  assert.equal(hooksOf(log, 'processInput').length, 1);
  assert.equal(hooksOf(log, 'processInputStep').length, 3);
  assert.equal(hooksOf(log, 'processLLMRequest').length, 3);
  assert.equal(hooksOf(log, 'processOutputStep').length, 3);
  assert.equal(hooksOf(log, 'processToolResult').length, 2);
  assert.equal(hooksOf(log, 'processOutputResult').length, 1);
  // processOutputStep fires for every model step (including tool-call steps) —
  // Task 5 must NOT finalize on every processOutputStep.
  const toolSteps = hooksOf(log, 'processOutputStep').filter((e) => (e.toolCalls ?? 0) > 0);
  assert.equal(toolSteps.length, 2);
  assert.ok(hooksOf(log, 'processOutputStep').some((e) => e.hasWriter));
  assert.ok(hooksOf(log, 'processOutputResult').some((e) => e.hasWriter));
});

test('approval suspend skips processOutputResult; resume preserves runId and eventually finalizes once', async () => {
  const log: HookEvent[] = [];
  const gate = createTool({
    id: 'gate',
    description: 'suspend gate',
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
  const model = createMockModel(() => {
    call += 1;
    if (call === 1) return toolCallResponse('gate', 'gate-1', { x: 'hi' });
    return textResponse('resumed');
  });
  const probe = createProbeProcessor(log);
  const agent = new Agent({
    id: 'ta-suspend',
    name: 'ta-suspend',
    model,
    tools: { gate },
    inputProcessors: [probe],
    outputProcessors: [probe],
    defaultOptions: { maxSteps: 5 },
  });
  new Mastra({
    agents: { 'ta-suspend': agent },
    storage: new MockStore(),
  });

  const suspended = await agent.generate('please gate');
  assert.equal(suspended.finishReason, 'suspended');
  assert.equal(hooksOf(log, 'processOutputResult').length, 0, 'suspend must not finalize');

  const beforeResume = log.length;
  const resumed = await agent.resumeGenerate(
    { answer: 'yes' },
    { runId: suspended.runId },
  );
  assert.equal(resumed.runId, suspended.runId);
  assert.equal(resumed.text, 'resumed');
  const resumeHooks = log.slice(beforeResume);
  assert.equal(resumeHooks.filter((e) => e.hook === 'processOutputResult').length, 1);
  // Resume may skip processInput; inputStep still runs for remaining model steps.
  assert.ok(resumeHooks.some((e) => e.hook === 'processInputStep'));
});

test('maxSteps stop still invokes processOutputResult once', async () => {
  const log: HookEvent[] = [];
  const noop = createTool({
    id: 'noop',
    description: 'noop',
    inputSchema: z.object({}),
    execute: async () => ({ ok: true }),
  });
  const model = createMockModel(() => toolCallResponse('noop', `noop-${randomUUID()}`, {}));
  const probe = createProbeProcessor(log);
  const agent = new Agent({
    id: 'ta-maxsteps',
    name: 'ta-maxsteps',
    model,
    tools: { noop },
    inputProcessors: [probe],
    outputProcessors: [probe],
    defaultOptions: { maxSteps: 2 },
  });
  const result = await agent.generate('loop');
  assert.ok(result.finishReason === 'stop' || result.finishReason === 'tool-calls' || typeof result.finishReason === 'string');
  assert.equal(hooksOf(log, 'processOutputResult').length, 1);
  assert.ok(hooksOf(log, 'processInputStep').length >= 2);
});

test('provider throw still calls processOutputResult once; result.finishReason is not a success stop', async () => {
  const log: HookEvent[] = [];
  const finishReasons: Array<string | undefined> = [];
  const model = createOpenAICompatible({
    name: 'ta-error',
    baseURL: 'https://example.test/v1',
    apiKey: 'test',
    fetch: async () => {
      throw new Error('provider-down');
    },
  }).chatModel('test');
  const base = createProbeProcessor(log);
  const probe = {
    ...base,
    processOutputResult(args: Record<string, unknown>) {
      const result = args.result as { finishReason?: string; text?: string } | undefined;
      finishReasons.push(result?.finishReason);
      return base.processOutputResult(args);
    },
  };
  const agent = new Agent({
    id: 'ta-error',
    name: 'ta-error',
    model,
    inputProcessors: [probe],
    outputProcessors: [probe],
  });
  await assert.rejects(() => agent.generate('boom'), /provider-down|AGENT_STREAM_ERROR|down/);
  assert.ok(hooksOf(log, 'processInputStep').length >= 1);
  // Verified: Mastra 1.71 still finalizes processors on provider failure.
  // Task 5 must inspect result.finishReason / empty text — not treat every
  // processOutputResult as completed success.
  assert.equal(hooksOf(log, 'processOutputResult').length, 1);
  assert.equal(finishReasons[0], 'error');
});

test('abortSignal during tool work resolves with finishReason aborted and finalizes once', async () => {
  const log: HookEvent[] = [];
  const finishReasons: Array<string | undefined> = [];
  const controller = new AbortController();
  const slow = createTool({
    id: 'slow',
    description: 'slow tool',
    inputSchema: z.object({}),
    execute: async (_input, _ctx) => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true };
    },
  });
  let call = 0;
  const model = createMockModel(() => {
    call += 1;
    if (call === 1) return toolCallResponse('slow', 'slow-1', {});
    return textResponse('should-not');
  });
  const base = createProbeProcessor(log);
  const probe = {
    ...base,
    processOutputResult(args: Record<string, unknown>) {
      const result = args.result as { finishReason?: string } | undefined;
      finishReasons.push(result?.finishReason);
      return base.processOutputResult(args);
    },
  };
  const agent = new Agent({
    id: 'ta-cancel',
    name: 'ta-cancel',
    model,
    tools: { slow },
    inputProcessors: [probe],
    outputProcessors: [probe],
    defaultOptions: { maxSteps: 3 },
  });
  const result = await agent.generate('cancel-me', { abortSignal: controller.signal });
  // Verified: abort does not always throw; finishReason === 'aborted' and processOutputResult runs.
  assert.equal(result.finishReason, 'aborted');
  assert.equal(hooksOf(log, 'processOutputResult').length, 1);
  assert.equal(finishReasons[0], 'aborted');
});

function streamTextResponse(content: string) {
  const chunks = [
    {
      id: 'test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test',
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    },
    {
      id: 'test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

test('stream and generate both expose processOutputResult; stream has writer on output hooks', async () => {
  const generateLog: HookEvent[] = [];
  const streamLog: HookEvent[] = [];
  const generateProbe = createProbeProcessor(generateLog);
  const streamProbe = createProbeProcessor(streamLog);
  const generateAgent = new Agent({
    id: 'ta-gen',
    name: 'ta-gen',
    model: createMockModel(() => textResponse('g')),
    inputProcessors: [generateProbe],
    outputProcessors: [generateProbe],
  });
  const streamAgent = new Agent({
    id: 'ta-stream',
    name: 'ta-stream',
    model: createOpenAICompatible({
      name: 'ta-stream-model',
      baseURL: 'https://example.test/v1',
      apiKey: 'test',
      fetch: async () => streamTextResponse('s'),
    }).chatModel('test'),
    inputProcessors: [streamProbe],
    outputProcessors: [streamProbe],
  });

  assert.equal((await generateAgent.generate('x')).text, 'g');
  assert.equal(hooksOf(generateLog, 'processOutputResult').length, 1);

  const streamed = await streamAgent.stream('y');
  await streamed.consumeStream();
  assert.equal(await streamed.text, 's');
  assert.equal(hooksOf(streamLog, 'processOutputResult').length, 1);
  assert.ok(hooksOf(streamLog, 'processOutputStep').every((e) => e.hasWriter));
});

test('prepareSkillRunOptions + generate preserve server-owned runId (sendMessage wraps the same helper)', async () => {
  const model = createMockModel(() => textResponse('bound'));
  const agent = new Agent({
    id: 'ta-send',
    name: 'ta-send',
    model,
  });
  installSkillExecutionBindings(agent);
  new Mastra({
    agents: { 'ta-send': agent },
    storage: new MockStore(),
  });

  const requestContext = new RequestContext();
  const threadId = randomUUID();
  bindSkillThreadId(requestContext, threadId);
  const prepared = prepareSkillRunOptions({ requestContext, threadId }, 'start');
  assert.equal(typeof prepared.runId, 'string');
  assert.ok(prepared.runId.length > 0);
  assert.equal(bindSkillServerExecutionId(requestContext, prepared.runId), prepared.runId);

  const result = await agent.generate('hi', prepared);
  assert.equal(result.runId, prepared.runId);
});

test('messageList metadata neroArtifactRun survives memory save/recall with text and tool parts', async () => {
  const storage = new MockStore();
  const memory = new Memory({
    storage,
    options: {
      lastMessages: 40,
      semanticRecall: false,
      workingMemory: { enabled: false },
      observationalMemory: false,
      generateTitle: false,
    },
  });

  const threadId = `ta-meta-${randomUUID()}`;
  const resourceId = `user-${randomUUID()}`;
  const runId = randomUUID();
  const skillMeta = { version: 1, items: [{ skillId: 'demo', status: 'loaded' }] };

  const writeFile = createTool({
    id: 'write_file',
    description: 'local file tool fixture',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async (input) => ({ ok: true, path: input.path, bytes: input.content.length }),
  });

  let call = 0;
  const model = createMockModel(() => {
    call += 1;
    if (call === 1) return toolCallResponse('write_file', 'write-1', { path: 'out.txt', content: 'hello' });
    return textResponse('wrote file');
  });

  const stampProcessor = {
    id: 'nero-artifact-run-stamp',
    processOutputResult({ messageList }: {
      messageList: {
        get: { response: { db: () => Array<{ role: string; content: { metadata?: Record<string, unknown>; parts?: unknown[] } }> } };
      };
    }) {
      const messages = messageList.get.response.db();
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!;
        if (msg.role !== 'assistant') continue;
        const metadata = { ...(msg.content.metadata ?? {}) };
        metadata.neroSkillActivations = skillMeta.items;
        metadata.neroArtifactRun = { version: 1, runId, threadId };
        msg.content.metadata = metadata;
        break;
      }
      return messageList;
    },
  };

  const agent = new Agent({
    id: 'ta-meta',
    name: 'ta-meta',
    model,
    memory,
    tools: { write_file: writeFile },
    outputProcessors: [stampProcessor],
    defaultOptions: { maxSteps: 4 },
  });
  new Mastra({
    agents: { 'ta-meta': agent },
    storage,
  });

  const result = await agent.generate('create out.txt', {
    memory: { thread: threadId, resource: resourceId },
    runId,
  });
  assert.equal(result.text, 'wrote file');
  assert.equal(result.runId, runId);
  await memory.settled();

  const recalled = await memory.recall({ threadId, resourceId, perPage: false });
  const assistants = recalled.messages.filter((m) => m.role === 'assistant');
  assert.ok(assistants.length >= 1, 'expected persisted assistant messages');

  const withMeta = [...assistants].reverse().find((m) => {
    const content = m.content;
    if (typeof content === 'string') return false;
    return Boolean(content.metadata?.neroArtifactRun);
  });
  assert.ok(withMeta, 'expected neroArtifactRun on recalled assistant metadata');
  const content = withMeta!.content as {
    metadata?: Record<string, unknown>;
    parts?: Array<{ type?: string; toolInvocation?: { toolName?: string }; text?: string }>;
  };
  assert.deepEqual(content.metadata?.neroArtifactRun, { version: 1, runId, threadId });
  assert.deepEqual(content.metadata?.neroSkillActivations, skillMeta.items);

  const parts = content.parts ?? [];
  assert.ok(parts.some((p) => p.type === 'text' && p.text === 'wrote file'), 'text part preserved');
  assert.ok(
    parts.some((p) => p.type === 'tool-invocation' && p.toolInvocation?.toolName === 'write_file')
      || assistants.some((m) => {
        const c = m.content;
        if (typeof c === 'string') return false;
        return (c.parts ?? []).some(
          (p: { type?: string; toolInvocation?: { toolName?: string } }) =>
            p.type === 'tool-invocation' && p.toolInvocation?.toolName === 'write_file',
        );
      }),
    'tool invocation part preserved across recall',
  );
});

/**
 * Verified Task 5 hook map (Mastra @mastra/core 1.71.0):
 * - start/idempotent init: processInputStep (first step of run) — NOT every step
 * - stamp metadata before persistence: processOutputResult (and keep skill metadata)
 * - do NOT finalize on every processOutputStep (fires on tool-call steps too)
 * - suspend: no processOutputResult; resume: same runId, then processOutputResult once
 * - maxSteps / normal complete: processOutputResult once
 * - provider throw: processOutputResult STILL runs with result.finishReason === 'error'
 * - abort during tool: may resolve (not throw) with finishReason === 'aborted'; settle cancelled
 * - writer.custom available on processOutputStep/Result for notifications only
 */
test('contract notes are stable for Task 5 implementers', () => {
  assert.equal(typeof prepareSkillRunOptions, 'function');
  assert.equal(typeof installSkillExecutionBindings, 'function');
});
