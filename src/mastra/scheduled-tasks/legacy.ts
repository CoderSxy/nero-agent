import type { ScheduleDriver } from './service';

export type LegacyScheduleAuditItem = {
  scheduleId: string;
  resourceId?: string;
  threadId?: string;
  status: 'active' | 'paused';
  importable: boolean;
  reason: string;
};

export type LegacyScheduleAudit = {
  importable: LegacyScheduleAuditItem[];
  indeterminate: LegacyScheduleAuditItem[];
};

/**
 * Read-only audit of agent schedules that lack `metadata.appTaskId`.
 * Does not delete, pause, or rewrite any schedule.
 */
export async function auditLegacySchedules(driver: ScheduleDriver): Promise<LegacyScheduleAudit> {
  const schedules = await driver.list({ agentId: 'agent' });
  const importable: LegacyScheduleAuditItem[] = [];
  const indeterminate: LegacyScheduleAuditItem[] = [];

  for (const schedule of schedules) {
    if (!('agentId' in schedule) || !schedule.agentId) continue;
    const metadata = schedule.metadata;
    const appTaskId = metadata && typeof metadata === 'object'
      ? (metadata as Record<string, unknown>).appTaskId
      : undefined;
    if (typeof appTaskId === 'string' && appTaskId) continue;

    const resourceId = schedule.resourceId;
    const threadId = 'threadId' in schedule ? schedule.threadId : undefined;
    const hasOwnerHint = typeof resourceId === 'string' && resourceId.length > 0;
    const item: LegacyScheduleAuditItem = {
      scheduleId: schedule.id,
      resourceId,
      threadId,
      status: schedule.status,
      importable: hasOwnerHint,
      reason: hasOwnerHint
        ? '可按 resourceId 归属导入，仍保持旧的绑定会话执行模式，需用户编辑后切换为每次新会话'
        : '缺少可信 resourceId/threadId，无法自动归属，需人工处理',
    };
    if (hasOwnerHint) importable.push(item);
    else indeterminate.push(item);
  }

  return { importable, indeterminate };
}
