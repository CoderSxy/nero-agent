import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { getPool } from '../src/mastra/auth/db';
import { createUser } from '../src/mastra/auth/service';
import {
  claimRun,
  finishRun,
  getTask,
  insertTask,
  listRuns,
  listTasks,
  updateTask,
} from '../src/mastra/scheduled-tasks/repository';
import type { TaskInput } from '../src/mastra/scheduled-tasks/types';

const hasDatabase = Boolean(process.env.DATABASE_URL);

function taskInput(name: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    name,
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    prompt: '每天汇报一次',
    chatModelRef: 'public:00000000-0000-4000-8000-000000000001',
    memoryModelRef: 'public:00000000-0000-4000-8000-000000000001',
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

test(
  'scheduled task repository enforces ownership, claim uniqueness, and soft-delete retention',
  { skip: !hasDatabase },
  async () => {
    assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be set for this database test');
    const suffix = randomUUID();
    const password = 'correct horse battery staple';
    const userIds: string[] = [];
    const taskIds: string[] = [];

    try {
      const userA = await createUser({
        email: `sched-a-${suffix}@example.test`,
        displayName: 'Sched A',
        password,
        role: 'admin',
      });
      userIds.push(userA.id);
      const userB = await createUser({
        email: `sched-b-${suffix}@example.test`,
        displayName: 'Sched B',
        password,
        role: 'admin',
      });
      userIds.push(userB.id);

      const taskA = await insertTask(userA.id, taskInput(`task-a-${suffix}`));
      taskIds.push(taskA.id);
      assert.equal(taskA.ownerUserId, userA.id);
      assert.equal(taskA.status, 'paused');
      assert.equal(taskA.mastraScheduleId, null);
      assert.equal(taskA.taskType, 'cron');

      const taskB = await insertTask(userB.id, taskInput(`task-b-${suffix}`));
      taskIds.push(taskB.id);

      const listedA = await listTasks(userA.id, { page: 1, pageSize: 50, q: suffix });
      assert.equal(listedA.items.length, 1);
      assert.equal(listedA.items[0]?.id, taskA.id);
      assert.ok(!listedA.items.some((item) => item.id === taskB.id));

      assert.equal(await getTask(taskB.id, userA.id), null);
      assert.equal((await getTask(taskA.id, userA.id))?.id, taskA.id);

      const scheduleId = `mastra-sched-${suffix}`;
      const activated = await updateTask(taskA.id, userA.id, {
        mastraScheduleId: scheduleId,
        status: 'active',
      });
      assert.ok(activated);
      assert.equal(activated.mastraScheduleId, scheduleId);
      assert.equal(activated.status, 'active');

      const firedAt = new Date('2026-10-15T01:00:00.000Z');
      const occurrenceKey = '2026-10-15T09:00:00+08:00';
      const firstClaim = await claimRun(taskA.id, 'cron', occurrenceKey, firedAt);
      assert.equal(firstClaim.created, true);
      assert.equal(firstClaim.run.taskId, taskA.id);
      assert.equal(firstClaim.run.ownerUserId, userA.id);
      assert.equal(firstClaim.run.triggerKind, 'cron');
      assert.equal(firstClaim.run.occurrenceKey, occurrenceKey);
      assert.equal(firstClaim.run.status, 'preparing');

      const secondClaim = await claimRun(taskA.id, 'cron', occurrenceKey, new Date('2026-10-15T01:00:05.000Z'));
      assert.equal(secondClaim.created, false);
      assert.equal(secondClaim.run.id, firstClaim.run.id);

      await finishRun(firstClaim.run.id, {
        status: 'succeeded',
        threadId: `thread-${suffix}`,
        runId: `run-${suffix}`,
        finishedAt: new Date('2026-10-15T01:01:00.000Z'),
      });

      const manualKey = randomUUID();
      const manualClaim = await claimRun(taskA.id, 'manual', manualKey, new Date());
      assert.equal(manualClaim.created, true);
      await finishRun(manualClaim.run.id, {
        status: 'failed',
        errorSummary: 'model unavailable',
        finishedAt: new Date(),
      });

      for (let i = 0; i < 3; i++) {
        const extra = await claimRun(taskA.id, 'manual', `${manualKey}-extra-${i}`, new Date());
        assert.equal(extra.created, true);
        await finishRun(extra.run.id, { status: 'succeeded', finishedAt: new Date() });
      }

      const page1 = await listRuns(taskA.id, userA.id, { page: 1, pageSize: 2 });
      assert.equal(page1.items.length, 2);
      assert.ok(page1.total >= 5);
      const page2 = await listRuns(taskA.id, userA.id, { page: 2, pageSize: 2 });
      assert.equal(page2.items.length, 2);
      assert.ok(!page1.items.some((run) => page2.items.some((other) => other.id === run.id)));

      assert.equal((await listRuns(taskA.id, userB.id, { page: 1, pageSize: 10 })).total, 0);

      const softDeleted = await updateTask(taskA.id, userA.id, { status: 'deleted' });
      assert.ok(softDeleted);
      assert.equal(softDeleted.status, 'deleted');
      assert.equal(await getTask(taskA.id, userA.id), null);
      assert.equal((await listTasks(userA.id, { page: 1, pageSize: 50, q: suffix })).items.length, 0);

      const runsAfterDelete = await listRuns(taskA.id, userA.id, { page: 1, pageSize: 50 });
      assert.ok(runsAfterDelete.total >= 5);
      assert.ok(runsAfterDelete.items.some((run) => run.id === firstClaim.run.id));
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
  },
);
