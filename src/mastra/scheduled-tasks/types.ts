export type TaskStatus = 'active' | 'paused' | 'deleted';
export type TriggerKind = 'cron' | 'manual';
export type RunStatus = 'preparing' | 'running' | 'succeeded' | 'failed' | 'aborted' | 'skipped';

export type TaskInput = {
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  chatModelRef?: string;
  memoryModelRef?: string;
  startsAt?: string | null;
  endsAt?: string | null;
};

export type ScheduledTask = {
  id: string;
  ownerUserId: string;
  mastraScheduleId: string | null;
  name: string;
  taskType: 'cron';
  cron: string;
  timezone: string;
  prompt: string;
  chatModelRef: string;
  memoryModelRef: string;
  startsAt: string | null;
  endsAt: string | null;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledTaskRun = {
  id: string;
  taskId: string;
  ownerUserId: string;
  triggerKind: TriggerKind;
  occurrenceKey: string;
  firedAt: string;
  threadId: string | null;
  status: RunStatus;
  runId: string | null;
  errorSummary: string | null;
  finishedAt: string | null;
};

export type TaskListQuery = {
  page: number;
  pageSize: number;
  q?: string;
};

export type PageQuery = {
  page: number;
  pageSize: number;
};

export type TaskPatch = Partial<{
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  chatModelRef: string;
  memoryModelRef: string;
  startsAt: string | null;
  endsAt: string | null;
  status: TaskStatus;
  mastraScheduleId: string | null;
}>;

export type RunFinishPatch = Partial<{
  status: RunStatus;
  threadId: string | null;
  runId: string | null;
  errorSummary: string | null;
  finishedAt: Date | string | null;
}>;

/** Safe DTO for management pages — includes derived schedule stats. */
export type TaskDto = Omit<ScheduledTask, 'prompt'> & {
  nextFireAt: string | null;
  lastFireAt: string | null;
  execCount: number;
};

/** Safe DTO for run logs — no raw prompt or internal stacks. */
export type RunDto = {
  id: string;
  taskId: string;
  triggerKind: TriggerKind;
  firedAt: string;
  threadId: string | null;
  status: RunStatus;
  errorSummary: string | null;
  finishedAt: string | null;
  durationMs: number | null;
};
