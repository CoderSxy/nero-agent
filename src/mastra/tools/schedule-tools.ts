import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const startScheduleTool = createTool({
  id: 'start_schedule',
  description: '为默认智能体创建周期性定时任务。',
  inputSchema: z.object({
    schedule: z.string().describe('指定运行时间的 Cron 表达式。'),
    prompt: z.string().describe('定时运行时使用的提示词。'),
  }),
  execute: async ({ schedule, prompt }, { mastra, agent }) => {
    if (!agent?.threadId || !agent.resourceId) {
      throw new Error('创建定时任务需要 threadId 和 resourceId。');
    }

    return mastra!.schedules.create({
      agentId: 'agent',
      cron: schedule,
      prompt,
      threadId: agent.threadId,
      resourceId: agent.resourceId,
    });
  },
});

export const stopScheduleTool = createTool({
  id: 'stop_schedule',
  description: '暂停指定定时任务。',
  inputSchema: z.object({
    scheduleId: z.string().describe('start_schedule 返回的定时任务 ID。'),
  }),
  execute: async ({ scheduleId }, { mastra }) => mastra!.schedules.pause(scheduleId),
});
