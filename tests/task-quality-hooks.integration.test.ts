import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createGuardedModelFetch } from '../src/mastra/models/transport';
import {
  createTaskBudgetFetch,
  mainBudgetCount,
  processorChargesBudget,
  reserveModelHttpAttempt,
  withTaskExecutionContext,
  type TaskSeamContext,
} from '../src/mastra/agents/task-quality/execution-context';
import { guardTaskTool } from '../src/mastra/agents/task-quality/tool-guard';

const BASE = 'https://example.test/v1';

function completion(content: string): Response {
  return Response.json({
    id: 'r',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function ledger(): TaskSeamContext['ledger'] {
  return { reservations: [] };
}

test('input processors run before the provider and output processors run after it', async () => {
  const order: string[] = [];
  let fetches = 0;
  const fetchImpl: typeof fetch = async () => {
    fetches += 1;
    order.push('fetch');
    return completion('ok');
  };
  const model = createOpenAICompatible({
    name: 'test',
    baseURL: BASE,
    apiKey: 'test',
    fetch: fetchImpl,
  }).chatModel('test');
  const agent = new Agent({
    id: 'hook-order',
    name: 'hook order',
    instructions: 'test',
    model,
    inputProcessors: [{ id: 'in', processInputStep() { order.push('input'); } }],
    outputProcessors: [{
      id: 'out',
      processOutputStep({ messageList }: { messageList: unknown }) {
        order.push('output');
        return messageList;
      },
    }],
  });
  assert.equal((await agent.generate('ping')).text, 'ok');
  assert.deepEqual(order, ['input', 'fetch', 'output']);
  assert.equal(fetches, 1);
});

test('a cached processLLMRequest response does not call the provider or reserve budget', async () => {
  const context: TaskSeamContext = { runId: 'run-cache', purpose: 'chat', ledger: ledger() };
  let fetches = 0;
  let saved: { chunks: unknown[] } | undefined;
  const responses: string[] = [];
  const network: typeof fetch = async () => {
    fetches += 1;
    return completion('live');
  };
  const model = createOpenAICompatible({
    name: 'test',
    baseURL: BASE,
    apiKey: 'test',
    fetch: createTaskBudgetFetch(new URL(BASE), network),
  }).chatModel('test');
  const agent = new Agent({
    id: 'hook-cache',
    name: 'hook cache',
    instructions: 'test',
    model,
    inputProcessors: [{
      id: 'cache',
      processLLMRequest() {
        if (saved) return { response: saved };
      },
      processLLMResponse({ chunks, fromCache }: { chunks: unknown[]; fromCache: boolean }) {
        assert.equal(fromCache, false);
        saved = { chunks };
      },
    }],
    outputProcessors: [{
      id: 'out',
      processOutputStep({ text, messageList }: { text?: string; messageList: unknown }) {
        responses.push(text ?? '');
        return messageList;
      },
    }],
  });
  await withTaskExecutionContext(context, () => agent.generate('ping'));
  const afterLive = fetches;
  const afterLiveBudget = mainBudgetCount(context.ledger);
  assert.equal(afterLive, 1);
  assert.equal(afterLiveBudget, 1);
  await withTaskExecutionContext(context, () => agent.generate('ping'));
  assert.equal(fetches, afterLive);
  assert.equal(mainBudgetCount(context.ledger), afterLiveBudget);
  assert.equal(processorChargesBudget(), false);
  assert.ok(responses.length >= 1);
});

test('provider retries are separate HTTP reservations and do not double-charge a single attempt', async () => {
  const context: TaskSeamContext = { runId: 'run-retry', purpose: 'chat', ledger: ledger() };
  let fetches = 0;
  const network: typeof fetch = async () => {
    fetches += 1;
    if (fetches === 1) return new Response('slow down', { status: 429 });
    return completion('retried');
  };
  const model = createOpenAICompatible({
    name: 'test',
    baseURL: BASE,
    apiKey: 'test',
    fetch: createTaskBudgetFetch(new URL(BASE), network),
  }).chatModel('test');
  const agent = new Agent({
    id: 'hook-retry',
    name: 'hook retry',
    instructions: 'test',
    model,
  });
  const text = await withTaskExecutionContext(context, () => agent.generate('ping', {
    modelSettings: { maxRetries: 1 },
  }));
  assert.equal(text.text, 'retried');
  assert.equal(fetches, 2);
  const main = context.ledger.reservations.filter(item => item.countsTowardMainBudget);
  assert.equal(main.length, 2);
  assert.equal(new Set(main.map(item => item.operationId)).size, 2);
  assert.equal(main.every(item => item.kind === 'main-model'), true);
  const again = context.ledger.reservations[0].operationId;
  const duplicate = await withTaskExecutionContext(context, () => reserveModelHttpAttempt(again));
  assert.equal(duplicate.duplicate, true);
  assert.equal(context.ledger.reservations.filter(item => item.countsTowardMainBudget).length, 2);
});

test('memory, title, and probe calls do not consume the main answer budget', async () => {
  const network: typeof fetch = async () => completion('side');
  const budgeted = createTaskBudgetFetch(new URL(BASE), network);
  for (const purpose of ['memory', 'title', 'probe'] as const) {
    const context: TaskSeamContext = { runId: null, purpose, ledger: ledger() };
    await withTaskExecutionContext(context, () => budgeted(`${BASE}/chat/completions`, { method: 'POST' }));
    assert.equal(context.ledger.reservations.length, 1);
    assert.equal(mainBudgetCount(context.ledger), 0);
    assert.equal(context.ledger.reservations[0].kind, 'auxiliary');
  }
  const escaped = ledger();
  const context: TaskSeamContext = { runId: 'run-chat', purpose: 'chat', ledger: escaped };
  await assert.rejects(
    () => withTaskExecutionContext(context, () => budgeted('https://127.0.0.1/v1/chat/completions', { method: 'POST' })),
  );
  assert.equal(escaped.reservations.length, 0);
  const guarded = createGuardedModelFetch(new URL(BASE), network);
  await assert.rejects(() => guarded('https://127.0.0.1/v1/chat/completions'));
});

test('tool guarding keeps inputSchema and reserves one tool start per call id', async () => {
  const schema = z.object({ city: z.string().min(1) });
  let runs = 0;
  const tool = createTool({
    id: 'echo_city',
    description: 'echo',
    inputSchema: schema,
    execute: async (input: { city: string }) => {
      runs += 1;
      return { city: input.city };
    },
  });
  const guarded = guardTaskTool(tool);
  assert.equal(guarded.inputSchema, tool.inputSchema);
  assert.equal(guarded.id, tool.id);
  const context: TaskSeamContext = { runId: 'run-tool', purpose: 'chat', ledger: ledger() };
  const first = await withTaskExecutionContext(context, () => guarded.execute!({ city: '上海' }, { toolCallId: 'call-1' }));
  const second = await withTaskExecutionContext(context, () => guarded.execute!({ city: '上海' }, { toolCallId: 'call-1' }));
  assert.equal(runs, 1);
  assert.deepEqual(first, { city: '上海' });
  assert.equal((second as { duplicate?: boolean }).duplicate, true);
  assert.equal(context.ledger.reservations.filter(item => item.kind === 'tool').length, 1);
  const requests: Array<{ tools?: Array<{ function: { name: string; parameters: { properties?: Record<string, unknown> } } }> }> = [];
  const model = createOpenAICompatible({
    name: 'test',
    baseURL: BASE,
    apiKey: 'test',
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const body = requests.at(-1)!;
      const called = body.tools ? undefined : 'done';
      if (body.tools && !requests.some(item => item !== body && !item.tools)) {
        return Response.json({
          id: 'r', object: 'chat.completion', created: 0, model: 'test',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              tool_calls: [{ id: 'call-schema', type: 'function', function: { name: 'echo_city', arguments: JSON.stringify({ city: '上海' }) } }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      return completion(called ?? 'done');
    },
  }).chatModel('test');
  const agent = new Agent({
    id: 'hook-schema',
    name: 'hook schema',
    instructions: 'test',
    model,
    tools: { echo_city: guarded },
    defaultOptions: { maxSteps: 4 },
  });
  await withTaskExecutionContext(context, () => agent.generate('上海'));
  const parameters = requests[0]?.tools?.find(item => item.function.name === 'echo_city')?.function.parameters;
  assert.ok(parameters?.properties && 'city' in parameters.properties);
});
