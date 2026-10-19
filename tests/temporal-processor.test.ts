import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import { createTemporalProcessor } from '../src/mastra/temporal/processor';
import { setScheduledTimezone } from '../src/mastra/temporal/context';

async function render(processor: ReturnType<typeof createTemporalProcessor>, state: Record<string, unknown>,
  requestContext = new RequestContext()) {
  const prompt = [{ role: 'system' as const, content: 'persona' },
    { role: 'user' as const, content: [{ type: 'text' as const, text: '近七天天气' }] }];
  const before = JSON.stringify(prompt);
  const result = await processor.processLLMRequest!({ prompt, state, requestContext, stepNumber: 0,
    steps: [], model: {} as never, abort: () => { throw new Error('abort'); }, retryCount: 0 });
  assert.equal(JSON.stringify(prompt), before, 'injection must not mutate history');
  assert.ok(result?.prompt);
  return result.prompt;
}

test('same run retains snapshot but a new run with reused request context refreshes', async () => {
  let now = new Date('2026-10-17T01:00:00Z');
  const processor = createTemporalProcessor({ now: () => now });
  const request = new RequestContext();
  request.set('currentDate', '2000-01-01');
  const state = {};
  const first = await render(processor, state, request);
  now = new Date('2026-10-17T02:00:00Z');
  assert.deepEqual(await render(processor, state, request), first);
  const concurrentRun = await render(processor, {}, request);
  assert.match(JSON.stringify(concurrentRun), /10:00:00\+08:00/);
  now = new Date('2026-10-18T01:00:00Z');
  const nextRun = await render(processor, {}, request);
  assert.match(JSON.stringify(nextRun), /2026-10-18/);
  assert.doesNotMatch(JSON.stringify(nextRun), /2000-01-01/);
});

test('a run crossing local midnight refreshes the calendar snapshot', async () => {
  let now = new Date('2026-10-17T15:59:00Z');
  const processor = createTemporalProcessor({ now: () => now });
  const state = {};
  assert.match(JSON.stringify(await render(processor, state)), /2026-10-17/);
  now = new Date('2026-10-17T16:01:00Z');
  assert.match(JSON.stringify(await render(processor, state)), /2026-10-18/);
});

test('trusted schedule timezone wins over client preference and forged timestamps', async () => {
  const request = new RequestContext();
  request.set('neroAgentTimezone', 'Asia/Shanghai');
  request.set('temporalContext', { date: '2000-01-01' });
  setScheduledTimezone(request, 'America/New_York');
  const processor = createTemporalProcessor({ now: () => new Date('2026-10-17T01:00:00Z') });
  const prompt = JSON.stringify(await render(processor, {}, request));
  assert.match(prompt, /America\/New_York/);
  assert.match(prompt, /2026-10-16/);
  assert.doesNotMatch(prompt, /2000-01-01/);
});

test('invalid client timezone falls back to Shanghai and valid preference is used', async () => {
  const processor = createTemporalProcessor({ now: () => new Date('2026-10-17T01:00:00Z') });
  const request = new RequestContext();
  request.set('neroAgentTimezone', 'invalid');
  assert.match(JSON.stringify(await render(processor, {}, request)), /Asia\/Shanghai/);
  request.set('neroAgentTimezone', 'America/New_York');
  assert.match(JSON.stringify(await render(processor, {}, request)), /2026-10-16/);
});


test('provider retries do not accumulate temporal messages in an already rewritten prompt', async () => {
  const processor = createTemporalProcessor({ now: () => new Date('2026-10-17T01:00:00Z') });
  const state = {};
  const prompt = await render(processor, state);
  const next = await processor.processLLMRequest!({ prompt, state, stepNumber: 0, steps: [], model: {} as never,
    abort: () => { throw new Error('abort'); }, retryCount: 1 });
  assert.ok(next?.prompt);
  assert.equal(next.prompt.filter(message => message.role === 'system'
    && message.content.startsWith('<current-time>')).length, 1);
});

test('scheduled timezone survives Mastra context serialization and reconstruction', async () => {
  const original = new RequestContext();
  setScheduledTimezone(original, 'America/New_York');
  const serialized = JSON.stringify(Object.fromEntries(original.entries()));
  const restored = new RequestContext(Object.entries(JSON.parse(serialized)));
  const processor = createTemporalProcessor({ now: () => new Date('2026-10-17T01:00:00Z') });
  const prompt = JSON.stringify(await render(processor, {}, restored));
  assert.match(prompt, /America\/New_York/);
  assert.match(prompt, /2026-10-16/);
});
