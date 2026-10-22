import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTurnPolicy } from '../src/mastra/agents/turn-policy';
import { resolveTaskBudget, resolveTaskQualityMode } from '../src/mastra/agents/task-quality/limits';
import { resolveTaskContract } from '../src/mastra/agents/task-quality/contract';

const now = new Date('2026-10-22T04:30:00.000Z');
const base = {
  runId: 'run-1',
  now,
  targetTimezone: 'Asia/Shanghai',
  hasAttachments: false,
  selectedSkillIds: [] as string[],
};

function contract(userText: string, extra: Record<string, unknown> = {}) {
  const turnPolicy = resolveTurnPolicy({
    userText,
    hasAttachments: Boolean(extra.hasAttachments),
    selectedSkillIds: extra.selectedSkillIds as string[] | undefined,
    previousDeliveryMode: extra.previousDeliveryMode as 'inline-chart' | undefined,
  });
  return resolveTaskContract({ ...base, userText, turnPolicy, ...extra });
}

function ids(userText: string, extra?: Record<string, unknown>) {
  return contract(userText, extra).requirements.map(item => `${item.id}:${item.importance}`);
}

test('weather trend contracts require the core fields and keep humidity optional', () => {
  const result = contract('给出上海未来七天天气趋势');
  assert.equal(result.domain, 'weather');
  assert.equal(result.profile, 'simple-chart');
  assert.equal(result.deliveryMode, 'inline-chart');
  assert.deepEqual(ids('给出上海未来七天天气趋势'), [
    'weather.location:required',
    'weather.range:required',
    'weather.condition:required',
    'weather.temperature:required',
    'weather.precipitation:required',
    'weather.humidity:optional',
    'delivery.chart:required',
  ]);
  const range = result.requirements.find(item => item.id === 'weather.range');
  assert.match(range?.description ?? '', /2026-10-22.*2026-10-28/);
});

test('temperature-only requests drop precipitation and explicit humidity becomes required', () => {
  assert.deepEqual(ids('上海未来七天只要气温，不要降雨'), [
    'weather.location:required',
    'weather.range:required',
    'weather.temperature:required',
    'delivery.chart:required',
  ]);
  const humid = contract('上海未来七天天气趋势，要每日湿度');
  assert.equal(humid.requirements.find(item => item.id === 'weather.humidity')?.importance, 'required');
  assert.match(contract('上海天气从明天开始').requirements.find(item => item.id === 'weather.range')?.description ?? '', /2026-10-23.*2026-10-29/);
});

test('html, attachments, skills, style follow-ups and plain questions keep their existing boundaries', () => {
  const html = contract('把说明做成 HTML 网页');
  assert.equal(html.deliveryMode, 'html-artifact');
  assert.equal(html.requirements.some(item => item.id.startsWith('weather.') || item.id === 'delivery.chart'), false);

  const attached = contract('根据附件画天气趋势', { hasAttachments: true });
  assert.equal(attached.deliveryMode, 'mixed');
  assert.notEqual(attached.profile, 'simple-chart');

  const skill = contract('用技能总结天气', { selectedSkillIds: ['skill-a'] });
  assert.equal(skill.deliveryMode, 'mixed');
  assert.equal(skill.profile, 'general');

  const previous = contract('给出上海未来七天天气趋势');
  const styled = contract('把标题换成红色', { previousDeliveryMode: 'inline-chart', previousContract: previous });
  assert.equal(styled.deliveryMode, 'inline-chart');
  assert.deepEqual(styled.requirements.map(item => item.id), previous.requirements.map(item => item.id));
  assert.equal(styled.requirements.find(item => item.id === 'weather.range')?.description, previous.requirements.find(item => item.id === 'weather.range')?.description);

  const answer = contract('什么是相对湿度');
  assert.equal(answer.profile, 'general');
  assert.equal(answer.domain, 'generic');
  assert.equal(answer.requirements.some(item => item.id === 'delivery.chart' || item.check !== 'declared-only'), false);
  assert.equal(answer.requirements[0]?.id, 'generic.explicit.1');
});

test('budgets match the phase-one profiles and reject invalid admin overrides', () => {
  assert.deepEqual(resolveTaskBudget('simple-chart'), { mainRequests: 8, repairs: 1, tools: 12, activeMs: 180_000 });
  assert.deepEqual(resolveTaskBudget('general'), { mainRequests: 20, repairs: 1, tools: 30, activeMs: 300_000 });
  assert.deepEqual(resolveTaskBudget('complex'), { mainRequests: 40, repairs: 1, tools: 60, activeMs: 900_000 });
  assert.equal(resolveTaskQualityMode(undefined), 'observe');
  assert.equal(resolveTaskQualityMode('enforce'), 'enforce');
  for (const value of [0, -1, Number.NaN, 101, 1.5, 'unlimited']) {
    assert.throws(() => resolveTaskBudget('general', { mainRequests: value as number }));
  }
  assert.throws(() => resolveTaskBudget('general', { repairs: 2 }));
  assert.throws(() => resolveTaskBudget('general', { tools: 101 }));
  assert.throws(() => resolveTaskBudget('general', { activeMs: 1_800_001 }));
  assert.throws(() => resolveTaskQualityMode('audit'));
});
