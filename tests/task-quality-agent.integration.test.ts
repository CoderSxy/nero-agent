import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskQualityProcessor } from '../src/mastra/agents/task-quality/processor';

const processor = createTaskQualityProcessor();

async function outcomeFor(userText: string, state: Record<string, unknown>, text = '') {
  const bag = { userGoal: userText, ...state };
  processor.processInputStep({ messages: [{ role: 'user', id: 'run-1', content: userText }], state: bag, requestContext: { get: () => undefined } });
  const parts: Array<{ data: { status: string; verification: string; revision: number; requirements: Array<{ id: string; status: string }> } }> = [];
  let repairs = 0;
  await processor.processOutputStep({ state: bag, text, abort() { repairs += 1; }, writer: { custom: async part => { parts.push(part as never); } } } as never);
  assert.equal(repairs, 0);
  return parts.at(-1)?.data;
}

test('task outcomes distinguish partial weather, verified weather, and ordinary answers', async () => {
  const partial = await outcomeFor('给出上海未来七天天气趋势', { chartSnapshot: { coverage: { complete: false, missing: ['weather.condition', 'weather.precipitation'] } } });
  assert.equal(partial?.status, 'partial');
  assert.equal(partial?.requirements.find(item => item.id === 'weather.temperature')?.status, 'met');
  const complete = await outcomeFor('给出上海未来七天天气趋势', { chartSnapshot: { coverage: { complete: true, missing: [] } } });
  assert.equal(complete?.status, 'complete');
  assert.equal(complete?.verification, 'verified');
  const answer = await outcomeFor('解释什么是相对湿度', {}, '相对湿度是空气含水汽的比例。'.repeat(4));
  assert.equal(answer?.status, 'complete');
  assert.equal(answer?.verification, 'model-assessed');
  const cancelled = await outcomeFor('给出上海未来七天天气趋势', { cancelled: true, chartSnapshot: { coverage: { complete: false, missing: ['weather.condition'] } } });
  assert.equal(cancelled?.status, 'cancelled');
  const failed = await outcomeFor('给出上海未来七天天气趋势', { deliveryUnavailable: true });
  assert.equal(failed?.status, 'failed');
  const file = await outcomeFor('导出销售 csv', { fileVerified: false }, '文件没有写成功');
  assert.notEqual(file?.status, 'complete');
  const again = await outcomeFor('解释什么是相对湿度', {}, '相对湿度是空气含水汽的比例。');
  assert.equal(again?.revision, 1);
});
