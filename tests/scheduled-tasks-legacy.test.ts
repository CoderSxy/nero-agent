import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLegacySchedules } from '../src/mastra/scheduled-tasks/legacy';
import type { ScheduleDriver } from '../src/mastra/scheduled-tasks/service';

test('legacy audit lists unmanaged schedules without mutating them', async () => {
  const ops: string[] = [];
  const driver: ScheduleDriver = {
    create: async () => { ops.push('create'); throw new Error('no'); },
    get: async () => { ops.push('get'); return null; },
    update: async (id) => { ops.push(`update:${id}`); throw new Error('no'); },
    pause: async (id) => { ops.push(`pause:${id}`); throw new Error('no'); },
    resume: async (id) => { ops.push(`resume:${id}`); throw new Error('no'); },
    run: async (id) => { ops.push(`run:${id}`); throw new Error('no'); },
    delete: async (id) => { ops.push(`delete:${id}`); },
    list: async () => [
      {
        id: 'agent_app',
        agentId: 'agent',
        prompt: 'x',
        cron: '0 9 * * *',
        status: 'active',
        resourceId: 'user-1',
        nextFireAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: { appTaskId: 'task-1' },
      },
      {
        id: 'agent_legacy',
        agentId: 'agent',
        prompt: 'old',
        cron: '0 10 * * *',
        status: 'active',
        resourceId: 'user-1',
        threadId: 'thread-1',
        nextFireAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'agent_orphan',
        agentId: 'agent',
        prompt: 'orphan',
        cron: '0 11 * * *',
        status: 'paused',
        nextFireAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  };

  const audit = await auditLegacySchedules(driver);
  assert.deepEqual(audit.importable.map((item) => item.scheduleId), ['agent_legacy']);
  assert.deepEqual(audit.indeterminate.map((item) => item.scheduleId), ['agent_orphan']);
  assert.ok(audit.importable[0]?.importable);
  assert.equal(ops.length, 0);
});
