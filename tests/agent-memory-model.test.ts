import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import { memoryForRequest } from '../src/mastra/agents/memory-model';

test('agent memory uses the request-scoped observation and reflection model', () => {
  const context = new RequestContext();
  context.set('nero-agent.memory-model', 'deepseek/deepseek-v4-pro');
  const memory = memoryForRequest({ requestContext: context });
  const config = memory.getMergedThreadConfig();
  assert.equal(config.observationalMemory?.observation?.model, 'deepseek/deepseek-v4-pro');
  assert.equal(config.observationalMemory?.reflection?.model, 'deepseek/deepseek-v4-pro');
});
