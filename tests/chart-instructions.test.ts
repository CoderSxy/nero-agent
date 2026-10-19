import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { agent as applicationAgent } from '../src/mastra/agents/agent';

test('application chart protocol reaches provider with inline defaults and explicit file exceptions', async () => {
  let payload: { messages: Array<{ role: string; content: string }> } | undefined;
  const instructions = await applicationAgent.getInstructions({ requestContext: new RequestContext() });
  const model = createOpenAICompatible({ name: 'test', baseURL: 'https://example.test/v1', apiKey: 'test',
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({ id: 'test', object: 'chat.completion', created: 0, model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    } }).chatModel('test');
  const agent = new Agent({ id: 'chart-policy-check', name: 'Chart policy check', model, instructions });
  await agent.generate('一月销售额10，二月20，请给趋势图');
  const system = payload!.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.match(system, /默认在当前会话内/);
  assert.match(system, /明确要求.*HTML/);
  assert.match(system, /严格 JSON/);
  assert.match(system, /"type":"line"/);
  assert.match(system, /mermaid/);
  assert.match(system, /不编造/);
});
