import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluationExitCode, loadQualityCases, runQualityEvaluation } from '../src/mastra/agents/task-quality/evaluation.ts';

test('fixture evaluation stays offline and passes the fixed suite twice', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error('fixture must not use the network'); }) as typeof fetch;
  try {
    const first = await runQualityEvaluation({ mode: 'fixture', maxMainModelCalls: 60 });
    const second = await runQualityEvaluation({ mode: 'fixture', maxMainModelCalls: 60 });
    assert.equal(calls, 0);
    assert.equal(first.passed, 20);
    assert.equal(first.hardFailures, 0);
    assert.equal(first.blocked, 0);
    assert.equal(first.price, null);
    assert.deepEqual(second.cases.map(item => [item.caseId, item.actualStatus, item.passed]), first.cases.map(item => [item.caseId, item.actualStatus, item.passed]));
    const temperatureOnly = first.cases.find(item => item.caseId === 'weather-temperature-only');
    assert.equal(temperatureOnly?.coverage.met.includes('weather.condition'), false);
    const missingCondition = first.cases.find(item => item.caseId === 'weather-condition-missing');
    assert.equal(missingCondition?.actualStatus, 'partial');
    assert.equal(missingCondition?.passed, true);
    assert.equal(first.cases.every(item => item.modelCalls === 0), true);
  } finally {
    globalThis.fetch = original;
  }
});

test('a hard mismatch exits 1 and live without a credential is blocked', async () => {
  const cases = loadQualityCases().filter(item => item.id === 'weather-condition-missing').map(item => ({ ...item, expect: { ...item.expect, status: 'complete' } }));
  const failed = await runQualityEvaluation({ mode: 'fixture', cases, maxMainModelCalls: 60 });
  assert.equal(failed.hardFailures, 1);
  assert.equal(evaluationExitCode(failed), 1);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error('live blocked'); }) as typeof fetch;
  delete process.env.EVAL_LIVE_API_KEY;
  try {
    const live = await runQualityEvaluation({ mode: 'live', modelRefs: ['model-a', 'model-b', 'model-c'], maxMainModelCalls: 60 });
    assert.equal(calls, 0);
    assert.equal(live.passed, 0);
    assert.equal(live.blocked, 5);
    assert.equal(live.hardFailures, 0);
    assert.equal(live.cases.every(item => item.passed === false), true);
  } finally {
    globalThis.fetch = original;
  }
});
