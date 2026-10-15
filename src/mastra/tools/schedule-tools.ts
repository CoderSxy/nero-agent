import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { RequestContext } from '@mastra/core/request-context';
import { trustedUser } from '../auth/auth-context';
import {
  ScheduledTaskError,
  createScheduledTaskService,
} from '../scheduled-tasks/service';
import { getTaskByMastraScheduleId } from '../scheduled-tasks/repository';

function ownerFrom(requestContext: RequestContext | undefined) {
  if (!requestContext) throw new Error('Authentication is required');
  return trustedUser(requestContext);
}

export const startScheduleTool = createTool({
  id: 'start_schedule',
  description: '为默认智能体创建周期性 Cron 定时任务（管理员）。',
  inputSchema: z.object({
    schedule: z.string().describe('指定运行时间的 Cron 表达式。'),
    prompt: z.string().describe('定时运行时使用的提示词。'),
    name: z.string().optional().describe('任务显示名称。'),
    timezone: z.string().optional().describe('IANA 时区，默认 Asia/Shanghai。'),
  }),
  execute: async ({ schedule, prompt, name, timezone }, { mastra, requestContext }) => {
    const owner = ownerFrom(requestContext as RequestContext | undefined);
    const service = createScheduledTaskService(mastra!.schedules);
    try {
      const task = await service.create(owner, {
        name: name?.trim() || '定时任务',
        cron: schedule,
        timezone: timezone?.trim() || 'Asia/Shanghai',
        prompt,
      });
      return { id: task.id, status: task.status, mastraScheduleId: task.mastraScheduleId };
    } catch (error) {
      if (error instanceof ScheduledTaskError) throw new Error(error.message);
      throw error;
    }
  },
});

export const stopScheduleTool = createTool({
  id: 'stop_schedule',
  description: '暂停指定定时任务。可传应用任务 ID，或识别旧的 Mastra schedule ID。',
  inputSchema: z.object({
    scheduleId: z.string().describe('应用任务 ID，或旧版 start_schedule 返回的 Mastra schedule ID。'),
  }),
  execute: async ({ scheduleId }, { mastra, requestContext }) => {
    const owner = ownerFrom(requestContext as RequestContext | undefined);
    const service = createScheduledTaskService(mastra!.schedules);
    try {
      const paused = await service.pause(owner, scheduleId);
      return { id: paused.id, status: paused.status };
    } catch (error) {
      if (!(error instanceof ScheduledTaskError) || error.code !== 'not_found') {
        if (error instanceof ScheduledTaskError) throw new Error(error.message);
        throw error;
      }
    }

    const legacy = await getTaskByMastraScheduleId(scheduleId);
    if (legacy && legacy.ownerUserId === owner.id && legacy.status !== 'deleted') {
      const paused = await service.pause(owner, legacy.id);
      return { id: paused.id, status: paused.status };
    }

    // Legacy Mastra-only schedule: pause only when resourceId matches the caller.
    const schedule = await mastra!.schedules.get(scheduleId);
    if (!schedule || !('agentId' in schedule)) {
      throw new Error('定时任务不存在');
    }
    if (schedule.resourceId !== owner.id) {
      throw new Error('定时任务不存在');
    }
    const metadata = schedule.metadata;
    const appTaskId = metadata && typeof metadata === 'object'
      ? (metadata as Record<string, unknown>).appTaskId
      : undefined;
    if (typeof appTaskId === 'string' && appTaskId) {
      // Owned app task referenced by mastra id but not found above — keep 404 shape.
      throw new Error('定时任务不存在');
    }
    await mastra!.schedules.pause(scheduleId);
    return { id: scheduleId, status: 'paused', legacy: true };
  },
});
