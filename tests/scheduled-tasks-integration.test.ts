import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { reconcileScheduledTasks } from '../src/mastra/scheduled-tasks/reconcile';
import type { ScheduleDriver } from '../src/mastra/scheduled-tasks/service';
import { getPool } from '../src/mastra/auth/db';
import { createUser } from '../src/mastra/auth/service';
import { insertTask, updateTask } from '../src/mastra/scheduled-tasks/repository';
import { auditLegacySchedules } from '../src/mastra/scheduled-tasks/legacy';

const hasDatabase = Boolean(process.env.DATABASE_URL);

test('reconcile repairs trigger configuration drift from application task data', async () => {
  const row = {
    id: randomUUID(), owner_user_id: randomUUID(), mastra_schedule_id: 'agent_drift',
    name: '晨报', cron: '0 9 * * *', timezone: 'Asia/Shanghai', prompt: '新提示词',
    status: 'active' as const,
  };
  const schedule = {
    id: 'agent_drift', agentId: 'agent', name: '旧名称', prompt: '旧提示词',
    cron: '0 8 * * *', timezone: 'UTC', status: 'active' as const,
    metadata: { appTaskId: row.id }, nextFireAt: Date.now(),
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  const patches: unknown[] = [];
  const driver = {
    get: async () => schedule,
    update: async (_id: string, patch: unknown) => { patches.push(patch); return { ...schedule, ...patch }; },
  } as unknown as ScheduleDriver;
  const result = await reconcileScheduledTasks(driver, 'agent', {
    loadRows: async () => [row],
  });
  assert.equal(result.repaired, 1);
  assert.deepEqual(patches[0], {
    name: row.name, cron: row.cron, timezone: row.timezone, prompt: row.prompt,
    metadata: { appTaskId: row.id },
  });
});

test('reconcile restores application task identity in trigger metadata', async () => {
  const row = { id: randomUUID(), owner_user_id: randomUUID(),
    mastra_schedule_id: 'agent_meta', name: '晨报', cron: '0 9 * * *',
    timezone: 'Asia/Shanghai', prompt: '汇报', status: 'active' as const };
  const schedule = { id: 'agent_meta', agentId: 'agent', name: row.name,
    cron: row.cron, timezone: row.timezone, prompt: row.prompt,
    status: 'active' as const, metadata: { appTaskId: randomUUID() },
    nextFireAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
  let corrected: unknown;
  const driver = { get: async () => schedule,
    update: async (_id: string, patch: unknown) => { corrected = patch; return { ...schedule, ...patch }; },
  } as unknown as ScheduleDriver;
  const result = await reconcileScheduledTasks(driver, 'agent', { loadRows: async () => [row] });
  assert.equal(result.repaired, 1);
  assert.deepEqual((corrected as { metadata: unknown }).metadata, { appTaskId: row.id });
});

test('reconcile removes a newly created trigger if linking it to the task fails', async () => {
  const row = { id: randomUUID(), owner_user_id: randomUUID(),
    mastra_schedule_id: null, name: '晨报', cron: '0 9 * * *',
    timezone: 'Asia/Shanghai', prompt: '汇报', status: 'active' as const };
  const deleted: string[] = [];
  const driver = {
    create: async () => ({ id: 'agent_orphan', status: 'active' }),
    delete: async (id: string) => { deleted.push(id); },
  } as unknown as ScheduleDriver;
  const result = await reconcileScheduledTasks(driver, 'agent', {
    loadRows: async () => [row],
    updateTask: async () => { throw new Error('database unavailable'); },
  });
  assert.equal(result.failed, 1);
  assert.deepEqual(deleted, ['agent_orphan']);
});

test('reconcile recreates missing triggers and repairs status drift',
  { skip: !hasDatabase }, async () => {
  const suffix = randomUUID();
  const password = 'correct horse battery staple';
  const userIds: string[] = [];
  const taskIds: string[] = [];
  const schedules = new Map<string, {
    id: string; agentId: string; prompt: string; cron: string; timezone?: string;
    status: 'active' | 'paused'; name?: string; metadata?: Record<string, unknown>;
    nextFireAt: number; createdAt: number; updatedAt: number;
  }>();

  const driver: ScheduleDriver = {
    create: async (input) => {
      const id = `agent_${randomUUID()}`;
      const row = {
        id,
        agentId: 'agent',
        prompt: input.prompt,
        cron: input.cron,
        timezone: input.timezone,
        status: input.status ?? 'active',
        name: input.name,
        metadata: input.metadata,
        nextFireAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      schedules.set(id, row);
      return row;
    },
    get: async (id) => schedules.get(id) ?? null,
    update: async (id, patch) => {
      const current = schedules.get(id);
      if (!current) throw new Error('missing');
      const next = { ...current, ...patch, updatedAt: Date.now() };
      schedules.set(id, next);
      return next;
    },
    pause: async (id) => {
      const current = schedules.get(id);
      if (!current) throw new Error('missing');
      current.status = 'paused';
      return current;
    },
    resume: async (id) => {
      const current = schedules.get(id);
      if (!current) throw new Error('missing');
      current.status = 'active';
      return current;
    },
    run: async (id) => ({ scheduleId: id, claimId: 'c', scheduledFireAt: Date.now() }),
    delete: async (id) => { schedules.delete(id); },
    list: async () => [...schedules.values()],
  };

  try {
    const admin = await createUser({
      email: `recon-${suffix}@example.test`,
      displayName: 'Recon',
      password,
      role: 'admin',
    });
    userIds.push(admin.id);

    const missing = await insertTask(admin.id, {
      name: `missing-${suffix}`,
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      prompt: 'hi',
      chatModelRef: 'public:11111111-1111-4111-8111-111111111111',
      memoryModelRef: 'public:11111111-1111-4111-8111-111111111111',
    });
    taskIds.push(missing.id);
    await updateTask(missing.id, admin.id, { status: 'active' });

    const drifted = await insertTask(admin.id, {
      name: `drift-${suffix}`,
      cron: '0 10 * * *',
      timezone: 'Asia/Shanghai',
      prompt: 'drift',
      chatModelRef: 'public:11111111-1111-4111-8111-111111111111',
      memoryModelRef: 'public:11111111-1111-4111-8111-111111111111',
    });
    taskIds.push(drifted.id);
    const scheduleId = `agent_drift_${suffix}`;
    schedules.set(scheduleId, {
      id: scheduleId,
      agentId: 'agent',
      prompt: 'drift',
      cron: '0 10 * * *',
      timezone: 'Asia/Shanghai',
      status: 'active',
      metadata: { appTaskId: drifted.id },
      nextFireAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await updateTask(drifted.id, admin.id, {
      mastraScheduleId: scheduleId,
      status: 'paused',
    });

    const deleted = await insertTask(admin.id, {
      name: `deleted-${suffix}`,
      cron: '0 11 * * *',
      timezone: 'Asia/Shanghai',
      prompt: 'gone',
      chatModelRef: 'public:11111111-1111-4111-8111-111111111111',
      memoryModelRef: 'public:11111111-1111-4111-8111-111111111111',
    });
    taskIds.push(deleted.id);
    await updateTask(deleted.id, admin.id, { status: 'deleted' });

    const legacyId = `agent_legacy_${suffix}`;
    schedules.set(legacyId, {
      id: legacyId,
      agentId: 'agent',
      prompt: 'legacy',
      cron: '0 12 * * *',
      status: 'active',
      resourceId: admin.id,
      nextFireAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);

    const result = await reconcileScheduledTasks(driver);
    assert.ok(result.repaired >= 2);
    assert.equal(result.failed, 0);

    const missingAfter = await getPool().query<{ mastra_schedule_id: string | null }>(
      'SELECT mastra_schedule_id FROM agent_scheduled_tasks WHERE id = $1', [missing.id]);
    assert.ok(missingAfter.rows[0]?.mastra_schedule_id);
    assert.equal(schedules.get(scheduleId)?.status, 'paused');

    const audit = await auditLegacySchedules(driver);
    assert.ok(audit.importable.some((item) => item.scheduleId === legacyId)
      || audit.indeterminate.some((item) => item.scheduleId === legacyId)
      || schedules.has(legacyId));
    assert.ok(schedules.has(legacyId), 'legacy schedule must remain untouched');
  } finally {
    const pool = getPool();
    if (taskIds.length) {
      await pool.query('DELETE FROM agent_scheduled_task_runs WHERE task_id = ANY($1::uuid[])', [taskIds]);
      await pool.query('DELETE FROM agent_scheduled_tasks WHERE id = ANY($1::uuid[])', [taskIds]);
    }
    if (userIds.length) {
      await pool.query('DELETE FROM app_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM app_user_roles WHERE user_id = ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [userIds]);
    }
  }
});
