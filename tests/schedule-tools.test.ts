import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import { getPool } from '../src/mastra/auth/db';
import { createUser, type AuthUser } from '../src/mastra/auth/service';
import { startScheduleTool, stopScheduleTool } from '../src/mastra/tools/schedule-tools';
import type { ScheduleDriver } from '../src/mastra/scheduled-tasks/service';
import { listTasks } from '../src/mastra/scheduled-tasks/repository';

function contextOf(owner: AuthUser) {
  const requestContext = new RequestContext();
  requestContext.set('mastra__user', owner);
  return requestContext;
}

function mockDriver(overrides: Partial<ScheduleDriver> = {}): ScheduleDriver {
  return {
    create: async (input) => ({
      id: `agent_${randomUUID()}`,
      agentId: 'agent',
      prompt: input.prompt,
      cron: input.cron,
      status: 'paused',
      nextFireAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: input.metadata,
    }),
    get: async () => null,
    update: async (id) => ({
      id, agentId: 'agent', prompt: 'x', cron: '0 9 * * *', status: 'active',
      nextFireAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
    }),
    pause: async (id) => ({
      id, agentId: 'agent', prompt: 'x', cron: '0 9 * * *', status: 'paused',
      nextFireAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
    }),
    resume: async (id) => ({
      id, agentId: 'agent', prompt: 'x', cron: '0 9 * * *', status: 'active',
      nextFireAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
    }),
    run: async (id) => ({ scheduleId: id, claimId: 'c', scheduledFireAt: Date.now() }),
    delete: async () => undefined,
    list: async () => [],
    ...overrides,
  };
}

test('ordinary users cannot create schedules through the agent tool', async () => {
  const regular = { id: randomUUID(), email: 'u@t.test', displayName: 'U', roles: ['user' as const] };
  await assert.rejects(
    () => startScheduleTool.execute?.(
      { schedule: '0 9 * * *', prompt: 'hello' },
      { mastra: { schedules: mockDriver() } as never, requestContext: contextOf(regular) } as never,
    ),
    /管理员/,
  );
});

test('start_schedule creates an app task and stop rejects foreign/unknown ids',
  { skip: !process.env.DATABASE_URL }, async () => {
  const suffix = randomUUID();
  const password = 'correct horse battery staple';
  const userIds: string[] = [];
  const taskIds: string[] = [];
  const driver = mockDriver({
    get: async (id) => {
      if (id === 'legacy-foreign') {
        return {
          id, agentId: 'agent', prompt: 'x', cron: '0 9 * * *', status: 'active',
          resourceId: randomUUID(), nextFireAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
        };
      }
      return null;
    },
  });

  try {
    const owner = await createUser({
      email: `tool-admin-${suffix}@example.test`,
      displayName: 'Tool Admin',
      password,
      role: 'admin',
    });
    userIds.push(owner.id);

    const result = await startScheduleTool.execute?.(
      { schedule: '0 9 * * *', prompt: 'hello', name: `tool-${suffix}`, timezone: 'Asia/Shanghai' },
      { mastra: { schedules: driver } as never, requestContext: contextOf(owner) } as never,
    ) as { id: string; status: string };
    assert.ok(result?.id);
    taskIds.push(result.id);
    const listed = await listTasks(owner.id, { page: 1, pageSize: 20, q: suffix });
    assert.ok(listed.items.some((item) => item.id === result.id));

    await assert.rejects(
      () => stopScheduleTool.execute?.(
        { scheduleId: 'missing' },
        { mastra: { schedules: driver } as never, requestContext: contextOf(owner) } as never,
      ),
      /不存在/,
    );
    await assert.rejects(
      () => stopScheduleTool.execute?.(
        { scheduleId: 'legacy-foreign' },
        { mastra: { schedules: driver } as never, requestContext: contextOf(owner) } as never,
      ),
      /不存在/,
    );
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
