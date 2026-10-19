import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { createTemporalProcessor } from '../src/mastra/temporal/processor';
import { temporalInstructions } from '../src/mastra/temporal/instructions';
import { agent as applicationAgent } from '../src/mastra/agents/agent';

test('real Mastra generate calls inject a fresh clock into the provider payload on each run', async () => {
  let now = new Date('2026-10-16T16:30:00Z');
  const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const model = createOpenAICompatible({ name: 'test', baseURL: 'https://example.test/v1', apiKey: 'test',
    fetch: async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'test', object: 'chat.completion', created: 0, model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    } }).chatModel('test');
  const agent = new Agent({ id: 'temporal-integration', name: 'Temporal integration', model,
    instructions: temporalInstructions, inputProcessors: [createTemporalProcessor({ now: () => now })] });
  const requestContext = new RequestContext();
  assert.equal((await agent.generate('近七天天气', { requestContext })).text, 'ok');
  now = new Date('2026-10-17T16:30:00Z');
  assert.equal((await agent.generate('近七天天气', { requestContext })).text, 'ok');
  assert.equal(payloads.length, 2);
  for (const [index, expectedDate] of ['2026-10-17', '2026-10-18'].entries()) {
    const clocks = payloads[index].messages.filter(message => message.role === 'system' && message.content.includes('<current-time>'));
    assert.equal(clocks.length, 1);
    assert.match(clocks[0].content, new RegExp(`今天：${expectedDate}`));
  }
});

test('application agent registers the temporal processor at its common model boundary', async () => {
  const processors = await applicationAgent.listConfiguredInputProcessors();
  assert.ok(processors.some(processor => 'id' in processor && processor.id === 'temporal-context'));
});

test('streaming model calls preserve the task timezone through the provider boundary', async () => {
  const { setScheduledTimezone } = await import('../src/mastra/temporal/context');
  let payload: { messages: Array<{ role: string; content: string }> } | undefined;
  const model = createOpenAICompatible({ name: 'test', baseURL: 'https://example.test/v1', apiKey: 'test',
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      const chunks = [
        { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'test',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
        { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'test',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    } }).chatModel('test');
  const agent = new Agent({ id: 'temporal-stream', name: 'Temporal stream', model,
    instructions: temporalInstructions,
    inputProcessors: [createTemporalProcessor({ now: () => new Date('2026-10-17T01:30:00Z') })] });
  const requestContext = new RequestContext();
  setScheduledTimezone(requestContext, 'America/New_York');
  const output = await agent.stream('今天', { requestContext });
  await output.consumeStream();
  assert.equal(await output.text, 'ok');
  const clocks = payload?.messages.filter(message => message.role === 'system' && message.content.includes('<current-time>'));
  assert.equal(clocks?.length, 1);
  assert.match(clocks![0].content, /今天：2026-10-16/);
  assert.match(clocks![0].content, /America\/New_York/);
});

test('real tool loop serializes Tavily filters and refreshes time after a search crosses midnight', async () => {
  const { tavilySearchTool } = await import('../src/mastra/tools/tavily-search-tool');
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TAVILY_API_KEY;
  let now = new Date('2026-10-17T15:59:00Z');
  let searchRequest: Record<string, unknown> | undefined;
  const payloads: Array<{ messages: Array<{ role: string; content: string }>;
    tools: Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }> }> = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.tavily.com/search');
    searchRequest = JSON.parse(String(init?.body));
    now = new Date('2026-10-17T16:01:00Z');
    return Response.json({ results: [{ title: 'Weather', url: 'https://example.test/weather',
      content: '今天15日，晴', published_date: null }] });
  };
  process.env.TAVILY_API_KEY = 'test-tool-loop';
  try {
    const model = createOpenAICompatible({ name: 'test', baseURL: 'https://example.test/v1', apiKey: 'test',
      fetch: async (_input, init) => {
        payloads.push(JSON.parse(String(init?.body)));
        const first = payloads.length === 1;
        return Response.json({ id: 'test', object: 'chat.completion', created: 0, model: 'test',
          choices: [{ index: 0, message: first ? { role: 'assistant', content: null,
            tool_calls: [{ id: 'search-1', type: 'function', function: { name: 'web_search',
              arguments: JSON.stringify({ query: '上海天气', timeRange: 'day', searchDepth: 'advanced' }) } }] }
            : { role: 'assistant', content: 'ok' }, finish_reason: first ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      } }).chatModel('test');
    const agent = new Agent({ id: 'temporal-tool-loop', name: 'Temporal tool loop', model,
      instructions: temporalInstructions, tools: { web_search: tavilySearchTool },
      inputProcessors: [createTemporalProcessor({ now: () => now })] });
    const result = await agent.generate('上海近七天天气', { maxSteps: 2 });
    assert.equal(result.text, 'ok');
    assert.equal(payloads.length, 2);
    const searchSchema = payloads[0].tools.find(tool => tool.function.name === 'web_search')?.function.parameters;
    assert.ok(searchSchema?.properties.timeRange);
    assert.ok(searchSchema?.properties.startDate);
    assert.ok(searchSchema?.properties.endDate);
    assert.ok(searchSchema?.properties.searchDepth);
    assert.equal(searchRequest?.time_range, 'day');
    assert.equal(searchRequest?.search_depth, 'advanced');
    assert.equal(searchRequest?.include_published_date, true);
    for (const [index, date] of ['2026-10-17', '2026-10-18'].entries()) {
      const clocks = payloads[index].messages.filter(message => message.role === 'system' && message.content.includes('<current-time>'));
      assert.equal(clocks.length, 1);
      assert.match(clocks[0].content, new RegExp(`今天：${date}`));
    }
    const toolResult = payloads[1].messages.find(message => message.role === 'tool');
    assert.ok(toolResult);
    assert.match(toolResult.content, /retrievedAt/);
    assert.match(toolResult.content, /publishedDate/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalKey;
  }
});
