import { apiFetch } from './client';

export type TaskDto = {
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
  status: 'active' | 'paused' | 'deleted';
  createdAt: string;
  updatedAt: string;
  nextFireAt: string | null;
  lastFireAt: string | null;
  execCount: number;
  selectedSkillIds?: string[];
};

export type RunDto = {
  id: string;
  taskId: string;
  triggerKind: 'cron' | 'manual';
  firedAt: string;
  threadId: string | null;
  status: 'preparing' | 'running' | 'succeeded' | 'failed' | 'aborted' | 'skipped';
  errorSummary: string | null;
  finishedAt: string | null;
  durationMs: number | null;
};

export type TaskInput = {
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  chatModelRef?: string;
  memoryModelRef?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  selectedSkillIds?: string[];
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error || `请求失败 (${response.status})`);
  }
  return body as T;
}

export async function listTasks(query: { page: number; pageSize: number; q?: string }) {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.q) params.set('q', query.q);
  return readJson<{ items: TaskDto[]; total: number }>(
    await apiFetch(`/agent-scheduled-tasks?${params}`),
  );
}

export async function createTask(input: TaskInput) {
  return readJson<{ task: TaskDto }>(await apiFetch('/agent-scheduled-tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export async function updateTask(id: string, input: TaskInput) {
  return readJson<{ task: TaskDto }>(await apiFetch(`/agent-scheduled-tasks/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export async function pauseTask(id: string) {
  return readJson<{ task: TaskDto }>(await apiFetch(`/agent-scheduled-tasks/${id}/pause`, { method: 'POST' }));
}

export async function resumeTask(id: string) {
  return readJson<{ task: TaskDto }>(await apiFetch(`/agent-scheduled-tasks/${id}/resume`, { method: 'POST' }));
}

export async function runTask(id: string) {
  return readJson<{ accepted: boolean; run: Pick<RunDto, 'id' | 'threadId' | 'status'> }>(
    await apiFetch(`/agent-scheduled-tasks/${id}/run`, { method: 'POST' }),
  );
}

export async function deleteTask(id: string) {
  return readJson<{ ok: boolean }>(await apiFetch(`/agent-scheduled-tasks/${id}`, { method: 'DELETE' }));
}

export async function listTaskRuns(id: string, query: { page: number; pageSize: number }) {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return readJson<{ items: RunDto[]; total: number }>(
    await apiFetch(`/agent-scheduled-tasks/${id}/runs?${params}`),
  );
}
