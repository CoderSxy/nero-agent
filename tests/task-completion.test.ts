import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTurnPolicy } from '../src/mastra/agents/turn-policy';
import { evaluateTaskCompletion } from '../src/mastra/agents/task-quality/completion';
import { resolveTaskContract } from '../src/mastra/agents/task-quality/contract';
import type { TaskContract } from '../src/mastra/agents/task-quality/types';

const now = new Date('2026-10-22T04:30:00.000Z');

function weatherContract(userText = '给出上海未来七天天气趋势'): TaskContract {
  return resolveTaskContract({
    runId: 'run-weather',
    userText,
    now,
    targetTimezone: 'Asia/Shanghai',
    hasAttachments: false,
    selectedSkillIds: [],
    turnPolicy: resolveTurnPolicy({ userText }),
  });
}

test('verified requirements complete only when every required check is met', () => {
  const contract = weatherContract();
  const coverage = {
    'weather.location': 'met',
    'weather.range': 'met',
    'weather.condition': 'met',
    'weather.temperature': 'met',
    'weather.precipitation': 'met',
    'delivery.chart': 'met',
  } as const;
  const done = evaluateTaskCompletion(contract, { weatherCoverage: coverage, chartVerified: true });
  assert.equal(done.status, 'complete');
  assert.equal(done.verification, 'verified');
  assert.equal(done.requirements.every(item => item.id === 'weather.humidity' || item.status === 'met'), true);

  const partial = evaluateTaskCompletion(contract, {
    weatherCoverage: { ...coverage, 'weather.condition': 'missing' },
    chartVerified: true,
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.requirements.find(item => item.id === 'weather.temperature')?.status, 'met');
  assert.equal(partial.requirements.find(item => item.id === 'weather.condition')?.status, 'missing');

  const failed = evaluateTaskCompletion(contract, { weatherCoverage: {}, chartVerified: false });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.requirements.some(item => item.status === 'met'), false);
});

test('cancellation and budget stops keep finished evidence', () => {
  const contract = weatherContract();
  const evidence = {
    weatherCoverage: { 'weather.location': 'met' as const, 'weather.temperature': 'met' as const },
    chartVerified: true,
  };
  const cancelled = evaluateTaskCompletion(contract, { ...evidence, cancelled: true });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.requirements.find(item => item.id === 'weather.temperature')?.status, 'met');

  const stopped = evaluateTaskCompletion(contract, { ...evidence, budgetStopped: true });
  assert.equal(stopped.status, 'partial');
  assert.equal(stopped.requirements.find(item => item.id === 'weather.temperature')?.status, 'met');
  assert.notEqual(stopped.status, 'failed');
});

test('declared answers stay model-assessed and unverified evidence never becomes met', () => {
  const contract = resolveTaskContract({
    runId: 'run-answer',
    userText: '解释什么是相对湿度',
    now,
    hasAttachments: false,
    selectedSkillIds: [],
    turnPolicy: resolveTurnPolicy({ userText: '解释什么是相对湿度' }),
  });
  const observed = evaluateTaskCompletion(contract, { answerText: '相对湿度是空气中水汽含量的比例。'.repeat(8) });
  const enforced = evaluateTaskCompletion(contract, { answerText: '相对湿度是空气中水汽含量的比例。'.repeat(8), mode: 'enforce' });
  assert.equal(observed.status, 'complete');
  assert.equal(observed.verification, 'model-assessed');
  assert.equal(observed.requirements[0]?.status, 'unverified');
  assert.deepEqual(enforced, observed);

  const weather = weatherContract();
  const unclear = evaluateTaskCompletion(weather, {
    weatherCoverage: { 'weather.temperature': 'unverified', 'weather.location': 'met' },
    chartVerified: false,
  });
  assert.equal(unclear.requirements.find(item => item.id === 'weather.temperature')?.status, 'unverified');
  assert.notEqual(unclear.status, 'complete');
});
