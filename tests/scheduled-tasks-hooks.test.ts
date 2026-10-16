import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import type { AuthUser } from '../src/mastra/auth/service';
import { memoryForRequest } from '../src/mastra/agents/memory-model';
import {
  createScheduledTaskHooks,
  runScheduledAgent,
  type ScheduledTaskHooksDeps,
} from '../src/mastra/scheduled-tasks/hooks';
import type { ScheduledTask, ScheduledTaskRun } from '../src/mastra/scheduled-tasks/types';

test('scheduled agent publishes a thread stream and waits for its completion', async () => {
  let release!: () => void;
  const completed = new Promise<void>(resolve => { release = resolve; });
  const calls: unknown[][] = [];
  const mastra = { getAgent: () => ({ sendMessage: (...args: unknown[]) => {
    calls.push(args);
    return { accepted: Promise.resolve({ action: 'wake', runId: 'model-run', output: {
      consumeStream: () => completed,
      text: completed.then(() => 'done'),
    } }) };
  } }) };
  const pending = runScheduledAgent({ mastra: mastra as never, agentId: 'agent', prompt: '天气',
    threadId: 'thread-1', resourceId: 'owner-1', requestContext: new RequestContext() });
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], '天气');
  const target = calls[0]?.[1] as { resourceId: string; threadId: string;
    ifIdle: { streamOptions: { requestContext: RequestContext } } };
  assert.equal(target.resourceId, 'owner-1');
  assert.equal(target.threadId, 'thread-1');
  assert.ok(target.ifIdle.streamOptions.requestContext instanceof RequestContext);
  release();
  assert.deepEqual(await pending, { runId: 'model-run' });
});

function admin(id = randomUUID()): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'Admin', roles: ['admin'] };
}

function taskRow(owner: AuthUser, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? randomUUID(),
    ownerUserId: owner.id,
    mastraScheduleId: 'agent_test',
    name: '晨报',
    taskType: 'cron',
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    prompt: '请汇报',
    chatModelRef: 'public:11111111-1111-4111-8111-111111111111',
    memoryModelRef: 'public:11111111-1111-4111-8111-111111111111',
    startsAt: null,
    endsAt: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDeps(seed: {
  owner: AuthUser;
  task: ScheduledTask;
  activeUser?: AuthUser | null;
  modelOk?: boolean;
}): ScheduledTaskHooksDeps & {
  runs: Map<string, ScheduledTaskRun>;
  threads: { id: string; metadata: Record<string, unknown> }[];
  generateCalls: number;
} {
  const runs = new Map<string, ScheduledTaskRun>();
  const threads: { id: string; metadata: Record<string, unknown> }[] = [];
  let generateCalls = 0;
  return {
    runs,
    threads,
    get generateCalls() { return generateCalls; },
    getActiveUserById: async (id) => {
      if (seed.activeUser === null) return null;
      const user = seed.activeUser ?? seed.owner;
      return user.id === id ? user : null;
    },
    findAuthorizedModel: async () => {
      if (seed.modelOk === false) throw Object.assign(new Error('disabled'), { name: 'ModelCatalogError', code: 'disabled' });
      return { id: 'ok' };
    },
    getTaskById: async (id) => (id === seed.task.id ? seed.task : null),
    claimRun: async (taskId, kind, occurrenceKey, firedAt) => {
      const existing = [...runs.values()].find((run) =>
        run.taskId === taskId && run.triggerKind === kind && run.occurrenceKey === occurrenceKey);
      if (existing) return { run: existing, created: false };
      if (kind === 'manual') {
        const inflight = [...runs.values()].find((run) =>
          run.taskId === taskId && run.triggerKind === 'manual'
          && (run.status === 'preparing' || run.status === 'running'));
        if (inflight) return { run: inflight, created: false };
      }
      const run: ScheduledTaskRun = {
        id: randomUUID(),
        taskId,
        ownerUserId: seed.owner.id,
        triggerKind: kind,
        occurrenceKey,
        firedAt: firedAt.toISOString(),
        threadId: null,
        status: 'preparing',
        runId: null,
        errorSummary: null,
        finishedAt: null,
      };
      runs.set(run.id, run);
      return { run, created: true };
    },
    startRun: async (runId) => {
      const run = runs.get(runId);
      if (!run || run.status !== 'preparing') return false;
      runs.set(runId, { ...run, status: 'running' });
      return true;
    },
    finishRun: async (runId, patch) => {
      const run = runs.get(runId);
      if (!run) return null;
      const next = {
        ...run,
        ...patch,
        finishedAt: patch.finishedAt === undefined
          ? run.finishedAt
          : patch.finishedAt === null
            ? null
            : new Date(patch.finishedAt as string | Date).toISOString(),
        status: patch.status ?? run.status,
        threadId: patch.threadId === undefined ? run.threadId : patch.threadId,
        runId: patch.runId === undefined ? run.runId : patch.runId,
        errorSummary: patch.errorSummary === undefined ? run.errorSummary : patch.errorSummary,
      } as ScheduledTaskRun;
      runs.set(runId, next);
      return next;
    },
    createThread: async ({ resourceId, title, metadata }) => {
      const thread = { id: randomUUID(), resourceId, title, metadata };
      threads.push(thread);
      return thread;
    },
    runAgent: async () => {
      generateCalls += 1;
      return { runId: `run-${generateCalls}` };
    },
  };
}

test('prepare creates an isolated schedule thread and run for app tasks', async () => {
  const owner = admin();
  const task = taskRow(owner);
  const deps = makeDeps({ owner, task });
  const hooks = createScheduledTaskHooks(deps);
  const result = await hooks.prepare!({
    mastra: {},
    agentId: 'agent',
    schedule: { id: 'agent_x', agentId: 'agent', metadata: { appTaskId: task.id }, prompt: task.prompt },
    trigger: { kind: 'cron', firedAt: new Date('2026-10-15T01:00:02.000Z') },
  });
  assert.equal(result, null);
  assert.equal(deps.threads.length, 1);
  assert.equal(deps.threads[0]?.metadata.neroAgentSourceType, 'schedule');
  assert.equal(deps.threads[0]?.metadata.neroAgentScheduleTaskId, task.id);
  assert.ok(deps.threads[0]?.title?.startsWith('定时任务：'));
  const run = [...deps.runs.values()][0];
  assert.ok(run);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.threadId, deps.threads[0]?.id);
  assert.equal(deps.generateCalls, 1);
});

test('same cron claim is idempotent and does not create a second thread', async () => {
  const owner = admin();
  const task = taskRow(owner);
  const deps = makeDeps({ owner, task });
  const hooks = createScheduledTaskHooks(deps);
  const ctx = {
    mastra: {},
    agentId: 'agent',
    schedule: { id: 'agent_x', agentId: 'agent', metadata: { appTaskId: task.id }, prompt: task.prompt },
    trigger: { kind: 'cron' as const, firedAt: new Date('2026-10-15T01:00:02.000Z') },
  };
  await hooks.prepare!(ctx);
  await hooks.prepare!(ctx);
  assert.equal(deps.threads.length, 1);
  assert.equal(deps.runs.size, 1);
  assert.equal(deps.generateCalls, 1);
});

test('concurrent cron deliveries create one thread while first worker is preparing', async () => {
  const owner = admin();
  const task = taskRow(owner);
  const deps = makeDeps({ owner, task });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const originalCreate = deps.createThread!;
  deps.createThread = async (input) => {
    entered();
    await gate;
    return originalCreate(input);
  };
  const hooks = createScheduledTaskHooks(deps);
  const ctx = {
    mastra: {}, agentId: 'agent',
    schedule: { id: 'agent_x', agentId: 'agent', metadata: { appTaskId: task.id } },
    trigger: { kind: 'cron' as const, firedAt: new Date('2026-10-15T01:00:02.000Z') },
  };
  const first = hooks.prepare!(ctx);
  await started;
  const second = hooks.prepare!(ctx);
  release();
  await Promise.all([first, second]);
  assert.equal(deps.threads.length, 1);
  assert.equal(deps.generateCalls, 1);
});

test('thread creation failure closes the claimed run as failed', async () => {
  const owner = admin();
  const task = taskRow(owner);
  const deps = makeDeps({ owner, task });
  deps.createThread = async () => { throw new Error('storage unavailable'); };
  const hooks = createScheduledTaskHooks(deps);
  await hooks.prepare!({
    mastra: {}, agentId: 'agent',
    schedule: { id: 'agent_x', agentId: 'agent', metadata: { appTaskId: task.id } },
    trigger: { kind: 'cron', firedAt: new Date('2026-10-15T01:00:02.000Z') },
  });
  assert.equal([...deps.runs.values()][0]?.status, 'failed');
});

test('default thread creation uses agent memory initialized with Mastra storage', async () => {
  const owner = admin();
  const task = taskRow(owner);
  const deps = makeDeps({ owner, task });
  delete deps.createThread;
  let memoryLookup = 0;
  const mastra = {
    getAgent: (id: string) => {
      assert.equal(id, 'agent');
      return { getMemory: async ({ requestContext }: { requestContext: RequestContext }) => {
        assert.equal(requestContext.get('mastra__user').id, owner.id);
        memoryLookup += 1;
        return { createThread: async ({ metadata }: { metadata: Record<string, unknown> }) => {
          assert.equal(metadata.neroAgentSourceType, 'schedule');
          return { id: 'stored-thread' };
        } };
      } };
    },
  };
  const hooks = createScheduledTaskHooks(deps);
  await hooks.prepare!({
    mastra: mastra as never, agentId: 'agent',
    schedule: { id: 'agent_x', agentId: 'agent', metadata: { appTaskId: task.id } },
    trigger: { kind: 'cron', firedAt: new Date('2026-10-15T01:00:02.000Z') },
  });
  assert.equal(memoryLookup, 1);
  assert.equal([...deps.runs.values()][0]?.status, 'succeeded');
  assert.equal([...deps.runs.values()][0]?.threadId, 'stored-thread');
});

test('owner lookup failure closes the claimed run as failed', async () => {
  const owner = admin();
  const task = taskRow(owner);
  const deps = makeDeps({ owner, task });
  deps.getActiveUserById = async () => { throw new Error('database unavailable'); };
  const hooks = createScheduledTaskHooks(deps);
  await hooks.prepare!({
    mastra: {}, agentId: 'agent',
    schedule: { id: 'agent_x', agentId: 'agent', metadata: { appTaskId: task.id } },
    trigger: { kind: 'cron', firedAt: new Date('2026-10-15T01:00:02.000Z') },
  });
  assert.equal([...deps.runs.values()][0]?.status, 'failed');
});

test('out of effective window is skipped without a thread', async () => {
  const owner = admin();
  const task = taskRow(owner, {
    startsAt: '2026-10-20T00:00:00.000Z',
    endsAt: '2026-10-30T00:00:00.000Z',
  });
  const deps = makeDeps({ owner, task });
  const hooks = createScheduledTaskHooks(deps);
  const result = await hooks.prepare!({
    mastra: {},
    agentId: 'agent',
    schedule: { id: 'agent_x', agentId: 'agent', metadata: { appTaskId: task.id }, prompt: task.prompt },
    trigger: { kind: 'cron', firedAt: new Date('2026-10-15T01:00:00.000Z') },
  });
  assert.equal(result, null);
  assert.equal(deps.threads.length, 0);
  assert.equal([...deps.runs.values()][0]?.status, 'skipped');
});

test('inactive owner or disabled model fails without creating a thread', async () => {
  const owner = admin();
  const task = taskRow(owner);
  const inactive = makeDeps({ owner, task, activeUser: null });
  const hooksA = createScheduledTaskHooks(inactive);
  await hooksA.prepare!({
    mastra: {},
    agentId: 'agent',
    schedule: { id: 'agent_x', agentId: 'agent', metadata: { appTaskId: task.id }, prompt: task.prompt },
    trigger: { kind: 'manual', firedAt: new Date() },
  });
  assert.equal(inactive.threads.length, 0);
  assert.equal([...inactive.runs.values()][0]?.status, 'failed');

  const badModel = makeDeps({ owner, task, modelOk: false });
  const hooksB = createScheduledTaskHooks(badModel);
  await hooksB.prepare!({
    mastra: {},
    agentId: 'agent',
    schedule: { id: 'agent_y', agentId: 'agent', metadata: { appTaskId: task.id }, prompt: task.prompt },
    trigger: { kind: 'manual', firedAt: new Date() },
  });
  assert.equal(badModel.threads.length, 0);
  assert.equal([...badModel.runs.values()][0]?.status, 'failed');
});

test('legacy schedules without appTaskId are untouched', async () => {
  const owner = admin();
  const task = taskRow(owner);
  const deps = makeDeps({ owner, task });
  const hooks = createScheduledTaskHooks(deps);
  const result = await hooks.prepare!({
    mastra: {},
    agentId: 'agent',
    schedule: { id: 'agent_legacy', agentId: 'agent', prompt: 'old' },
    trigger: { kind: 'cron', firedAt: new Date() },
  });
  assert.equal(result, undefined);
  assert.equal(deps.threads.length, 0);
  assert.equal(deps.runs.size, 0);
});

test('onFinish skipped is a no-op when prepare already finalized the run', async () => {
  const owner = admin();
  const task = taskRow(owner);
  const deps = makeDeps({ owner, task });
  const hooks = createScheduledTaskHooks(deps);
  await hooks.prepare!({
    mastra: {},
    agentId: 'agent',
    schedule: { id: 'agent_x', agentId: 'agent', metadata: { appTaskId: task.id }, prompt: task.prompt },
    trigger: { kind: 'cron', firedAt: new Date('2026-10-15T01:00:02.000Z') },
  });
  const run = [...deps.runs.values()][0]!;
  await hooks.onFinish!({
    mastra: {},
    agentId: 'agent',
    schedule: { id: 'agent_x', agentId: 'agent', metadata: { appTaskId: task.id } },
    trigger: { kind: 'cron', firedAt: new Date() },
    outcome: 'skipped',
    effective: { prompt: task.prompt, threadId: run.threadId ?? undefined },
  });
  assert.equal(deps.runs.get(run.id)?.status, 'succeeded');
});

test('memoryForRequest allows missing request context for read-only default memory',
  { skip: !process.env.DATABASE_URL }, async () => {
  process.env.MODEL_CONFIG_ENCRYPTION_KEY ||= Buffer.alloc(32).toString('base64');
  const empty = new RequestContext();
  const memory = await memoryForRequest({ requestContext: empty });
  assert.ok(memory);
  assert.equal(typeof memory.getThreadById, 'function');
});
