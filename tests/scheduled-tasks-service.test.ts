import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../src/mastra/auth/service';
import {
  ScheduledTaskError,
  createScheduledTaskService,
  type ScheduleDriver,
  type ScheduledTaskServiceDeps,
} from '../src/mastra/scheduled-tasks/service';
import type { ScheduledTask, ScheduledTaskRun, TaskInput } from '../src/mastra/scheduled-tasks/types';

function admin(id = 'admin-a'): AuthUser {
  return { id, email: `${id}@example.test`, displayName: id, roles: ['admin'] };
}

function user(id = 'user-a'): AuthUser {
  return { id, email: `${id}@example.test`, displayName: id, roles: ['user'] };
}

function input(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    name: '晨报',
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    prompt: '汇总昨日进展',
    chatModelRef: 'public:11111111-1111-4111-8111-111111111111',
    memoryModelRef: 'public:11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

function task(ownerId: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? randomUUID(),
    ownerUserId: ownerId,
    mastraScheduleId: overrides.mastraScheduleId ?? `agent_${randomUUID()}`,
    name: '晨报',
    taskType: 'cron',
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    prompt: '汇总昨日进展',
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

async function assertCode(promise: Promise<unknown>, code: ScheduledTaskError['code']) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ScheduledTaskError, `expected ScheduledTaskError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function mockDriver(overrides: Partial<ScheduleDriver> = {}): ScheduleDriver & {
  calls: { run: string[]; create: number; delete: string[]; pause: string[]; resume: string[] };
} {
  const calls = { run: [] as string[], create: 0, delete: [] as string[], pause: [] as string[], resume: [] as string[] };
  return {
    calls,
    create: async () => {
      calls.create += 1;
      return {
        id: `agent_${randomUUID()}`,
        agentId: 'agent',
        prompt: 'x',
        cron: '0 9 * * *',
        status: 'paused',
        nextFireAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
    get: async () => null,
    update: async (id) => ({
      id,
      agentId: 'agent',
      prompt: 'x',
      cron: '0 9 * * *',
      status: 'active',
      nextFireAt: Date.now() + 60_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    pause: async (id) => {
      calls.pause.push(id);
      return {
        id,
        agentId: 'agent',
        prompt: 'x',
        cron: '0 9 * * *',
        status: 'paused',
        nextFireAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
    resume: async (id) => {
      calls.resume.push(id);
      return {
        id,
        agentId: 'agent',
        prompt: 'x',
        cron: '0 9 * * *',
        status: 'active',
        nextFireAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
    run: async (id) => {
      calls.run.push(id);
      return { scheduleId: id, claimId: randomUUID(), scheduledFireAt: Date.now() };
    },
    delete: async (id) => {
      calls.delete.push(id);
    },
    list: async () => [],
    ...overrides,
  };
}

function baseDeps(overrides: Partial<ScheduledTaskServiceDeps> = {}): ScheduledTaskServiceDeps {
  const driver = mockDriver();
  const tasks = new Map<string, ScheduledTask>();
  const runs = new Map<string, ScheduledTaskRun>();
  return {
    driver,
    agentId: 'agent',
    findAuthorizedModel: async () => ({ id: 'ok' }),
    resolveDefaultModelRefs: async () => ({
      chatModelRef: 'public:11111111-1111-4111-8111-111111111111',
      memoryModelRef: 'public:11111111-1111-4111-8111-111111111111',
    }),
    insertTask: async (ownerId, input) => {
      const row = task(ownerId, {
        id: randomUUID(),
        mastraScheduleId: null,
        status: 'paused',
        name: input.name,
        cron: input.cron,
        timezone: input.timezone,
        prompt: input.prompt,
        chatModelRef: input.chatModelRef!,
        memoryModelRef: input.memoryModelRef!,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
      });
      tasks.set(row.id, row);
      return row;
    },
    getTask: async (id, ownerId) => {
      const row = tasks.get(id);
      if (!row || row.ownerUserId !== ownerId || row.status === 'deleted') return null;
      return row;
    },
    updateTask: async (id, ownerId, patch) => {
      const row = tasks.get(id);
      if (!row || row.ownerUserId !== ownerId) return null;
      const next = { ...row, ...patch, updatedAt: new Date().toISOString() };
      tasks.set(id, next as ScheduledTask);
      return next as ScheduledTask;
    },
    listTasks: async (ownerId) => ({
      items: [...tasks.values()].filter((row) => row.ownerUserId === ownerId && row.status !== 'deleted'),
      total: [...tasks.values()].filter((row) => row.ownerUserId === ownerId && row.status !== 'deleted').length,
    }),
    claimRun: async (taskId, kind, occurrenceKey, firedAt) => {
      const inflight = [...runs.values()].find(
        (run) => run.taskId === taskId && run.triggerKind === 'manual'
          && (run.status === 'preparing' || run.status === 'running'),
      );
      if (kind === 'manual' && inflight) return { run: inflight, created: false };
      const existing = [...runs.values()].find(
        (run) => run.taskId === taskId && run.triggerKind === kind && run.occurrenceKey === occurrenceKey,
      );
      if (existing) return { run: existing, created: false };
      const run: ScheduledTaskRun = {
        id: randomUUID(),
        taskId,
        ownerUserId: tasks.get(taskId)?.ownerUserId ?? 'unknown',
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
    listRuns: async () => ({ items: [], total: 0 }),
    getRunStats: async () => ({ lastFireAt: null, execCount: 0 }),
    ...overrides,
  };
}

test('non-admin cannot manage scheduled tasks', async () => {
  const service = createScheduledTaskService(baseDeps());
  await assertCode(service.create(user(), input()), 'forbidden');
  await assertCode(service.list(user(), { page: 1, pageSize: 10 }), 'forbidden');
});

test('rejects empty prompt, invalid cron/timezone, reversed range, and unauthorized models', async () => {
  const deps = baseDeps({
    findAuthorizedModel: async () => {
      throw Object.assign(new Error('not found'), { code: 'not_found', name: 'ModelCatalogError' });
    },
  });
  const service = createScheduledTaskService(deps);
  const owner = admin();
  await assertCode(service.create(owner, input({ prompt: '   ' })), 'invalid_input');
  await assertCode(service.create(owner, input({ cron: 'not a cron' })), 'invalid_input');
  await assertCode(service.create(owner, input({ timezone: 'Not/A_Zone' })), 'invalid_input');
  await assertCode(service.create(owner, input({
    startsAt: '2026-10-20T00:00:00.000Z',
    endsAt: '2026-10-10T00:00:00.000Z',
  })), 'invalid_input');
  await assertCode(service.create(owner, input({
    chatModelRef: 'public:22222222-2222-4222-8222-222222222222',
  })), 'invalid_input');
});

test('foreign task ids return the same not_found for all mutating actions', async () => {
  const owned = task('admin-a');
  const deps = baseDeps({
    getTask: async (id, ownerId) => (id === owned.id && ownerId === 'admin-a' ? owned : null),
  });
  const service = createScheduledTaskService(deps);
  const foreign = admin('admin-b');
  const id = owned.id;
  await assertCode(service.edit(foreign, id, input()), 'not_found');
  await assertCode(service.pause(foreign, id), 'not_found');
  await assertCode(service.resume(foreign, id), 'not_found');
  await assertCode(service.run(foreign, id), 'not_found');
  await assertCode(service.remove(foreign, id), 'not_found');
  await assertCode(service.runs(foreign, id, { page: 1, pageSize: 10 }), 'not_found');
});

test('concurrent manual runs only invoke driver.run once', async () => {
  const owned = task('admin-a', { status: 'active' });
  let claimCount = 0;
  let releaseGate: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const driver = mockDriver({
    run: async (id) => {
      await gate;
      driver.calls.run.push(id);
      return { scheduleId: id, claimId: randomUUID(), scheduledFireAt: Date.now() };
    },
  });
  const deps = baseDeps({
    driver,
    getTask: async (id, ownerId) => (id === owned.id && ownerId === 'admin-a' ? owned : null),
    claimRun: async (taskId, kind, occurrenceKey, firedAt) => {
      claimCount += 1;
      if (claimCount === 1) {
        return {
          created: true,
          run: {
            id: randomUUID(),
            taskId,
            ownerUserId: 'admin-a',
            triggerKind: kind,
            occurrenceKey,
            firedAt: firedAt.toISOString(),
            threadId: null,
            status: 'preparing',
            runId: null,
            errorSummary: null,
            finishedAt: null,
          },
        };
      }
      return {
        created: false,
        run: {
          id: 'existing-run',
          taskId,
          ownerUserId: 'admin-a',
          triggerKind: 'manual',
          occurrenceKey: 'other',
          firedAt: firedAt.toISOString(),
          threadId: null,
          status: 'preparing',
          runId: null,
          errorSummary: null,
          finishedAt: null,
        },
      };
    },
  });
  const service = createScheduledTaskService(deps);
  const p1 = service.run(admin('admin-a'), owned.id);
  const p2 = service.run(admin('admin-a'), owned.id);
  releaseGate!();
  const results = await Promise.all([p1, p2]);
  assert.equal(driver.calls.run.length, 1);
  assert.equal(results.filter((result) => result.accepted).length, 1);
  assert.equal(results.filter((result) => !result.accepted).length, 1);
});

test('paused tasks reject manual run', async () => {
  const owned = task('admin-a', { status: 'paused' });
  const driver = mockDriver();
  const service = createScheduledTaskService(baseDeps({
    driver,
    getTask: async (id, ownerId) => (id === owned.id && ownerId === 'admin-a' ? owned : null),
  }));
  await assertCode(service.run(admin('admin-a'), owned.id), 'conflict');
  assert.equal(driver.calls.run.length, 0);
});
