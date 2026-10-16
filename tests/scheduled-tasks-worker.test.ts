import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { agent } from '../src/mastra/agents/agent';
import { createScheduledTaskHooks } from '../src/mastra/scheduled-tasks/hooks';
import type { ScheduledTask, ScheduledTaskRun } from '../src/mastra/scheduled-tasks/types';

test('installed Mastra worker dispatches a manual app schedule with owner context and final status',
  { timeout: 15_000 }, async () => {
  const ownerId = randomUUID();
  const taskId = randomUUID();
  const ref = `public:${randomUUID()}`;
  const task: ScheduledTask = {
    id: taskId, ownerUserId: ownerId, mastraScheduleId: null,
    name: '集成测试', taskType: 'cron', cron: '0 0 1 1 *', timezone: 'UTC',
    prompt: '测试', chatModelRef: ref, memoryModelRef: ref,
    startsAt: null, endsAt: null, status: 'active',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  let run: ScheduledTaskRun | null = null;
  let contextVerified = false;
  let releaseAgent!: () => void;
  let agentEntered!: () => void;
  const agentGate = new Promise<void>((resolve) => { releaseAgent = resolve; });
  const entered = new Promise<void>((resolve) => { agentEntered = resolve; });
  let completed!: () => void;
  const done = new Promise<void>((resolve) => { completed = resolve; });
  const hooks = createScheduledTaskHooks({
    getTaskById: async () => task,
    getActiveUserById: async () => ({ id: ownerId, email: 'worker@example.test',
      displayName: 'Worker', roles: ['admin'] }),
    findAuthorizedModel: async () => ({ id: 'ok' }),
    claimRun: async (_taskId, kind, occurrenceKey, firedAt) => {
      if (run) return { run, created: false };
      run = { id: randomUUID(), taskId, ownerUserId: ownerId, triggerKind: kind,
        occurrenceKey, firedAt: firedAt.toISOString(), threadId: null,
        status: 'preparing', runId: null, errorSummary: null, finishedAt: null };
      return { run, created: true };
    },
    startRun: async () => {
      if (!run || run.status !== 'preparing') return false;
      run = { ...run, status: 'running' };
      return true;
    },
    finishRun: async (_id, patch) => {
      assert.ok(run);
      run = { ...run, ...patch, finishedAt: patch.finishedAt instanceof Date
        ? patch.finishedAt.toISOString() : run.finishedAt };
      if (run.status === 'succeeded') completed();
      return run;
    },
    createThread: async ({ metadata, resourceId }) => {
      assert.equal(resourceId, ownerId);
      assert.equal(metadata.neroAgentSourceType, 'schedule');
      return { id: randomUUID() };
    },
    runAgent: async ({ requestContext, threadId, resourceId }) => {
      assert.equal(requestContext.get('mastra__user').id, ownerId);
      assert.equal(requestContext.get('nero-agent.chat-model-ref'), ref);
      assert.equal(resourceId, ownerId);
      assert.ok(threadId);
      contextVerified = true;
      agentEntered();
      await agentGate;
      return { runId: 'worker-run' };
    },
  });
  const mastra = new Mastra({
    agents: { agent }, schedules: hooks,
    storage: new LibSQLStore({ id: `test-${randomUUID()}`, url: 'file::memory:' }),
  });
  let scheduleId: string | null = null;
  try {
    await mastra.startWorkers();
    const schedule = await mastra.schedules.create({ agentId: 'agent', cron: task.cron,
      timezone: task.timezone, prompt: task.prompt, metadata: { appTaskId: taskId } });
    scheduleId = schedule.id;
    await mastra.schedules.run(scheduleId);
    await entered;
    assert.equal(run?.status, 'running', 'the application log must not succeed before the agent ends');
    releaseAgent();
    await done;
    assert.equal(contextVerified, true);
    assert.equal(run?.status, 'succeeded');
    assert.ok(run?.threadId);
  } finally {
    releaseAgent();
    if (scheduleId) await mastra.schedules.delete(scheduleId);
    await mastra.shutdown();
  }
});
