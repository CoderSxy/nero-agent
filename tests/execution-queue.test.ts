import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionQueue } from '../src/mastra/sandbox/execution-queue';

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('the same thread never overlaps two executions', async () => {
  const queue = new ExecutionQueue(2);
  const active: number[] = [];
  const overlapping: number[] = [];
  const run = (id: number) =>
    queue.run('u', 't1', async () => {
      if (active.length) overlapping.push(...active, id);
      active.push(id);
      await delay(20);
      active.splice(active.indexOf(id), 1);
      return id;
    });
  const results = await Promise.all([run(1), run(2)]);
  assert.deepEqual(results, [1, 2]);
  assert.deepEqual(overlapping, []);
});

test('two threads can run while a third waits for the global limit', async () => {
  const queue = new ExecutionQueue(2);
  let concurrent = 0;
  let max = 0;
  const started: string[] = [];
  const run = (threadId: string) =>
    queue.run('u', threadId, async () => {
      started.push(threadId);
      concurrent += 1;
      max = Math.max(max, concurrent);
      await delay(30);
      concurrent -= 1;
    });
  await Promise.all([run('a'), run('b'), run('c')]);
  assert.equal(max, 2);
  assert.equal(started.length, 3);
});

test('cancel, timeout and thrown errors release locks', async () => {
  const queue = new ExecutionQueue(2);
  const controller = new AbortController();
  const hold = () => delay(40);
  const a = queue.run('u', 'a', hold);
  const b = queue.run('u', 'b', hold);
  await delay(5);
  const waiting = queue.run('u', 'c', async () => 'no', controller.signal);
  controller.abort();
  await assert.rejects(() => waiting);
  await assert.rejects(() =>
    queue.run('u', 'boom', async () => {
      throw new Error('boom');
    }),
  );
  await Promise.all([a, b]);
  const result = await queue.run('u', 'ok', async () => 'ok');
  assert.equal(result, 'ok');
});

test('a resumed run uses the same key and does not overlap the first run', async () => {
  const queue = new ExecutionQueue(2);
  let current = 0;
  let max = 0;
  const first = queue.run('u', 't', async () => {
    current += 1;
    max = Math.max(max, current);
    await delay(20);
    current -= 1;
  });
  await first;
  await queue.run('u', 't', async () => {
    current += 1;
    max = Math.max(max, current);
    await delay(5);
    current -= 1;
  });
  assert.equal(max, 1);
});
