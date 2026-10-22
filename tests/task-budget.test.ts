import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBudget, localStopMessage } from '../src/mastra/agents/task-quality/budget';
import { withTaskExecutionContext, type TaskSeamContext } from '../src/mastra/agents/task-quality/execution-context';

const auth = { userId: 'user-a', threadId: 'thread-a' };

async function fill(budget: ReturnType<typeof createMemoryBudget>, kind: 'main-model' | 'repair-model' | 'tool', count: number) {
  const results = [];
  for (let index = 0; index < count; index += 1) {
    results.push(await budget.reserve(auth, { runId: 'run-1', operationId: `${kind}-${index}`, kind, profile: 'simple-chart', mode: 'enforce' }));
  }
  return results;
}

test('simple-chart budgets stop the ninth model call, the second repair, and the thirteenth tool', async () => {
  const budget = createMemoryBudget();
  const mains = await fill(budget, 'main-model', 8);
  assert.equal(mains.every(item => item.allowed), true);
  const ninth = await budget.reserve(auth, { runId: 'run-1', operationId: 'main-9', kind: 'main-model', profile: 'simple-chart', mode: 'enforce' });
  assert.equal(ninth.allowed, false);
  const repair = await budget.reserve(auth, { runId: 'run-1', operationId: 'repair-1', kind: 'repair-model', profile: 'simple-chart', mode: 'enforce' });
  assert.equal(repair.allowed, true);
  const secondRepair = await budget.reserve(auth, { runId: 'run-1', operationId: 'repair-2', kind: 'repair-model', profile: 'simple-chart', mode: 'enforce' });
  assert.equal(secondRepair.allowed, false);
  const tools = await fill(budget, 'tool', 12);
  assert.equal(tools.every(item => item.allowed), true);
  const extraTool = await budget.reserve(auth, { runId: 'run-1', operationId: 'tool-13', kind: 'tool', profile: 'simple-chart', mode: 'enforce' });
  assert.equal(extraTool.allowed, false);
});

test('larger profiles, retries, cache, and duplicate events use the exact limits', async () => {
  const general = createMemoryBudget();
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await general.reserve(auth, { runId: 'g', operationId: `m${index}`, kind: 'main-model', profile: 'general', mode: 'enforce' })).allowed, true);
  }
  assert.equal((await general.reserve(auth, { runId: 'g', operationId: 'm21', kind: 'main-model', profile: 'general', mode: 'enforce' })).allowed, false);
  const complex = createMemoryBudget();
  for (let index = 0; index < 40; index += 1) {
    assert.equal((await complex.reserve(auth, { runId: 'c', operationId: `m${index}`, kind: 'main-model', profile: 'complex', mode: 'enforce' })).allowed, true);
  }
  assert.equal((await complex.reserve(auth, { runId: 'c', operationId: 'm41', kind: 'main-model', profile: 'complex', mode: 'enforce' })).allowed, false);
  const retries = createMemoryBudget();
  assert.equal((await retries.reserve(auth, { runId: 'r', operationId: 'attempt-1', kind: 'main-model', profile: 'simple-chart', mode: 'enforce' })).allowed, true);
  assert.equal((await retries.reserve(auth, { runId: 'r', operationId: 'attempt-2', kind: 'main-model', profile: 'simple-chart', mode: 'enforce' })).allowed, true);
  const again = await retries.reserve(auth, { runId: 'r', operationId: 'attempt-1', kind: 'main-model', profile: 'simple-chart', mode: 'enforce' });
  assert.equal(again.duplicate, true);
  assert.equal(again.remaining.mainRequests, 6);
  assert.equal(retries.cachedResponses, 0);
  retries.noteCachedResponse();
  assert.equal(retries.cachedResponses, 1);
  assert.equal((await retries.reserve(auth, { runId: 'r', operationId: 'attempt-3', kind: 'main-model', profile: 'simple-chart', mode: 'enforce' })).remaining.mainRequests, 5);
});

test('parallel reservations cannot pass the last slot and contexts stay separate', async () => {
  const budget = createMemoryBudget();
  await fill(budget, 'main-model', 7);
  const [left, right] = await Promise.all([
    budget.reserve(auth, { runId: 'run-1', operationId: 'left', kind: 'main-model', profile: 'simple-chart', mode: 'enforce' }),
    budget.reserve(auth, { runId: 'run-1', operationId: 'right', kind: 'main-model', profile: 'simple-chart', mode: 'enforce' }),
  ]);
  assert.equal([left.allowed, right.allowed].filter(Boolean).length, 1);
  const other = createMemoryBudget();
  const first = withTaskExecutionContext(context('run-a'), () => other.reserve(auth, { runId: 'run-a', operationId: 'a', kind: 'tool', profile: 'general', mode: 'enforce' }));
  const second = withTaskExecutionContext(context('run-b'), () => other.reserve({ userId: 'user-b', threadId: 'thread-b' }, { runId: 'run-b', operationId: 'a', kind: 'tool', profile: 'general', mode: 'enforce' }));
  assert.equal((await first).allowed, true);
  assert.equal((await second).allowed, true);
  assert.equal((await other.reserve(auth, { runId: 'run-a', operationId: 'a', kind: 'tool', profile: 'general', mode: 'enforce' })).duplicate, true);
});

test('observe records a stop without blocking, and enforce closes when storage fails', async () => {
  const budget = createMemoryBudget();
  await fill(budget, 'main-model', 8);
  const observed = await budget.reserve(auth, { runId: 'run-1', operationId: 'over', kind: 'main-model', profile: 'simple-chart', mode: 'observe' });
  assert.equal(observed.allowed, true);
  assert.equal(observed.wouldStop, true);
  const closed = createMemoryBudget({ failStorage: true });
  const denied = await closed.reserve(auth, { runId: 'down', operationId: 'x', kind: 'main-model', profile: 'general', mode: 'enforce' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'unavailable');
  assert.match(localStopMessage('预算用尽'), /不再请求模型/);
});

function context(runId: string): TaskSeamContext {
  return { runId, purpose: 'chat', ledger: { reservations: [] } };
}
