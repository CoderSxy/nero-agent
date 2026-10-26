import { createThreadHistoryCache } from './thread-history-cache';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTasksPage } from './ScheduledTasksPage';
import type { AgentShellContextValue } from './AgentShell';

const listTasks = vi.fn();
const createTask = vi.fn();
const updateTask = vi.fn();
const pauseTask = vi.fn();
const resumeTask = vi.fn();
const runTask = vi.fn();
const deleteTask = vi.fn();
const listTaskRuns = vi.fn();
const getSelectableModels = vi.fn();
const refreshThreadList = vi.fn();

vi.mock('./model-catalog-client', () => ({
  getSelectableModels: (...args: unknown[]) => getSelectableModels(...args),
}));

const listAvailableSkills = vi.hoisted(() => vi.fn());
vi.mock('./skills/skills-api', () => ({
  listAvailableSkills: (...args: unknown[]) => listAvailableSkills(...args),
}));
vi.mock('./scheduled-tasks-api', () => ({
  listTasks: (...args: unknown[]) => listTasks(...args),
  createTask: (...args: unknown[]) => createTask(...args),
  updateTask: (...args: unknown[]) => updateTask(...args),
  pauseTask: (...args: unknown[]) => pauseTask(...args),
  resumeTask: (...args: unknown[]) => resumeTask(...args),
  runTask: (...args: unknown[]) => runTask(...args),
  deleteTask: (...args: unknown[]) => deleteTask(...args),
  listTaskRuns: (...args: unknown[]) => listTaskRuns(...args),
}));

const task = {
  id: 'task-1',
  ownerUserId: 'admin',
  mastraScheduleId: 'agent_x',
  name: '晨报',
  taskType: 'cron' as const,
  cron: '0 9 * * *',
  timezone: 'Asia/Shanghai',
  prompt: '汇报',
  chatModelRef: 'public:1',
  memoryModelRef: 'public:1',
  startsAt: null,
  endsAt: null,
  status: 'active' as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  nextFireAt: null,
  lastFireAt: null,
  execCount: 2,
};

function context(isAdmin: boolean): AgentShellContextValue {
  return {
    user: {
      id: 'u1',
      email: 'a@t.test',
      displayName: 'A',
      roles: isAdmin ? ['admin'] : ['user'],
    },
    threadHistoryCache: createThreadHistoryCache(),
    onLogout: vi.fn(),
    list: { refresh: refreshThreadList } as never,
    threadSource: 'default',
    setThreadSource: vi.fn(),
    visibleThreads: [],
    historySearch: {} as never,
    theme: 'dark',
    setTheme: vi.fn(),
    setChatActions: vi.fn(),
    deleteThread: vi.fn(),
  };
}

function renderWithContext(isAdmin = true) {
  const value = context(isAdmin);
  return render(<MemoryRouter initialEntries={['/scheduled-tasks']}>
    <Routes>
      <Route element={<Outlet context={value} />}>
        <Route path="/scheduled-tasks" element={<ScheduledTasksPage />} />
      </Route>
    </Routes>
  </MemoryRouter>);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

beforeEach(() => {
  listAvailableSkills.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
  listTasks.mockResolvedValue({ items: [task], total: 1 });
  listTaskRuns.mockResolvedValue({ items: [], total: 0 });
  createTask.mockResolvedValue({ task });
  updateTask.mockResolvedValue({ task });
  pauseTask.mockResolvedValue({ task: { ...task, status: 'paused' } });
  resumeTask.mockResolvedValue({ task });
  runTask.mockResolvedValue({ accepted: true });
  refreshThreadList.mockResolvedValue(undefined);
  deleteTask.mockResolvedValue({ ok: true });
  getSelectableModels.mockResolvedValue([
    { ref: 'public:1', displayName: '默认模型', scope: 'public', enabled: true, isDefault: true },
    { ref: 'private:2', displayName: '我的模型', scope: 'private', enabled: true },
  ]);
});

describe('ScheduledTasksPage', () => {
  it('refreshes scheduled conversations after an asynchronous manual run creates its thread', async () => {
    runTask.mockResolvedValue({ accepted: true, run: { id: 'run-1' } });
    listTaskRuns
      .mockResolvedValueOnce({ items: [{ id: 'run-1', threadId: null, status: 'running' }], total: 1 })
      .mockResolvedValueOnce({ items: [{ id: 'run-1', threadId: 'thread-1', status: 'running' }], total: 1 });
    renderWithContext(true);

    fireEvent.click(await screen.findByRole('button', { name: '立即运行' }));
    await waitFor(() => expect(refreshThreadList).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(listTaskRuns).toHaveBeenCalledWith('task-1', { page: 1, pageSize: 20 });
  });

  it('shows an error instead of crashing when the task API returns an invalid list', async () => {
    listTasks.mockResolvedValue({});
    renderWithContext(true);
    const center = await screen.findByRole('region', { name: '定时任务列表' });
    expect(await within(center).findByRole('alert')).toHaveProperty('textContent', '定时任务列表响应格式错误');
    expect(within(center).queryByText('暂无定时任务')).toBeNull();
  });

  it('uses the full content area without a right panel and opens editing and logs in modals', async () => {
    renderWithContext(true);
    const center = await screen.findByRole('region', { name: '定时任务列表' });
    expect(within(center).getByRole('heading', { name: '晨报' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: '定时任务详情与配置' })).toBeNull();
    expect(screen.queryByRole('button', { name: '查看配置' })).toBeNull();
    expect(within(center).getByText('汇报')).toBeTruthy();

    fireEvent.click(within(center).getByRole('button', { name: '编辑' }));
    const modal = screen.getByRole('dialog', { name: '编辑定时任务' });
    expect(within(modal).getByRole('form', { name: '定时任务配置' })).toBeTruthy();

    fireEvent.click(within(modal).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog', { name: '编辑定时任务' })).toBeNull();
    fireEvent.click(within(center).getByRole('button', { name: '日志' }));
    await waitFor(() => expect(listTaskRuns).toHaveBeenCalledWith('task-1', { page: 1, pageSize: 20 }));
    const logs = screen.getByRole('dialog', { name: '执行日志' });
    expect(within(logs).getByRole('heading', { name: '晨报 · 执行日志' })).toBeTruthy();
    fireEvent.click(within(logs).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog', { name: '执行日志' })).toBeNull();
  });

  it('blocks non-admins', async () => {
    renderWithContext(false);
    expect((await screen.findByRole('alert')).textContent).toContain('无权限');
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('loads tasks and supports create pause run delete and logs', async () => {
    renderWithContext(true);
    const center = await screen.findByRole('region', { name: '定时任务列表' });
    expect(within(center).getByRole('heading', { name: '晨报' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '新增任务' }));
    const modal = screen.getByRole('dialog', { name: '新增定时任务' });
    expect((within(modal).getByLabelText('时区') as HTMLInputElement).value).toBe('Asia/Shanghai');
    expect(within(modal).getAllByRole('combobox', { name: '模型' })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('任务名'), { target: { value: '晚报' } });
    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '总结' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createTask).toHaveBeenCalled());
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({
      chatModelRef: 'public:1', memoryModelRef: 'public:1', timezone: 'Asia/Shanghai',
    });
    expect(createTask.mock.calls[0]?.[0].selectedSkillIds).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    await waitFor(() => expect(pauseTask).toHaveBeenCalledWith('task-1'));
    fireEvent.click(screen.getByRole('button', { name: '立即运行' }));
    await waitFor(() => expect(runTask).toHaveBeenCalledWith('task-1'));
    fireEvent.click(screen.getByRole('button', { name: '日志' }));
    await waitFor(() => expect(listTaskRuns).toHaveBeenCalledWith('task-1', { page: 1, pageSize: 20 }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(deleteTask).toHaveBeenCalledWith('task-1'));
  });

  it('edits selected models and task-zone effective time without resetting them', async () => {
    listTasks.mockResolvedValue({ items: [{ ...task,
      chatModelRef: 'private:2', memoryModelRef: 'private:2',
      startsAt: '2026-10-20T01:00:00.000Z',
    }], total: 1 });
    renderWithContext(true);
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    expect((screen.getByLabelText('开始') as HTMLInputElement).value).toBe('2026-10-20T09:00');
    expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('private:2');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalled());
    expect(updateTask.mock.calls[0]?.[1]).toMatchObject({
      chatModelRef: 'private:2', memoryModelRef: 'private:2',
      startsAt: '2026-10-20T01:00:00.000Z',
    });
    expect(updateTask.mock.calls[0]?.[1].selectedSkillIds).toBeUndefined();
  });

  it('lets an edited private-model task switch back to the public default', async () => {
    listTasks.mockResolvedValue({ items: [{ ...task,
      chatModelRef: 'private:2', memoryModelRef: 'private:2',
    }], total: 1 });
    renderWithContext(true);
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await screen.findAllByRole('option', { name: '默认模型' });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalled());
    expect(updateTask.mock.calls[0]?.[1]).toMatchObject({
      chatModelRef: 'public:1', memoryModelRef: 'public:1',
    });
  });

  it('saves selected skills and still edits a task that has no skill field', async () => {
    const skill = {
      id: '11111111-1111-4111-8111-111111111111', name: 'alpha', description: 'a', version: 1,
      userInvocable: true, availability: 'instructions-only',
    };
    listAvailableSkills.mockResolvedValue({ items: [skill], total: 1, page: 1, pageSize: 50 });
    renderWithContext(true);
    fireEvent.click(screen.getByRole('button', { name: '新增任务' }));
    fireEvent.change(screen.getByLabelText('任务名'), { target: { value: '带技能' } });
    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '总结' } });
    fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    fireEvent.click(await screen.findByRole('option', { name: 'alpha' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createTask).toHaveBeenCalled());
    expect(createTask.mock.calls.at(-1)?.[0].selectedSkillIds).toEqual([skill.id]);
  });
});
