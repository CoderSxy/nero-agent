import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBudget } from '../src/mastra/agents/task-quality/budget';
import { createTaskBudgetFetch, withTaskExecutionContext } from '../src/mastra/agents/task-quality/execution-context';

test('an enforced budget stops the model fetch before the network call', async () => {
  const budget = createMemoryBudget();
  const auth = { userId: 'user-a', threadId: 'thread-a' };
  for (let index = 0; index < 8; index += 1) {
    await budget.reserve(auth, { runId: 'run-budget', operationId: `seed-${index}`, kind: 'main-model', profile: 'simple-chart', mode: 'enforce' });
  }
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response('ok');
  };
  const guarded = createTaskBudgetFetch(new URL('https://models.example.test/v1/'), fetchImpl);
  await assert.rejects(withTaskExecutionContext({
    runId: 'run-budget',
    purpose: 'chat',
    ledger: { reservations: [] },
    budgetGate: { reserve: (kind, operationId) => budget.reserve(auth, { runId: 'run-budget', operationId, kind, profile: 'simple-chart', mode: 'enforce' }) },
  }, () => guarded('https://models.example.test/v1/chat/completions', {})));
  assert.equal(calls, 0);
});
