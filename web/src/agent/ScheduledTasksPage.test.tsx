import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    onLogout: vi.fn(),
    list: {} as never,
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
  listTasks.mockResolvedValue({ items: [task], total: 1 });
  listTaskRuns.mockResolvedValue({ items: [], total: 0 });
  createTask.mockResolvedValue({ task });
  updateTask.mockResolvedValue({ task });
  pauseTask.mockResolvedValue({ task: { ...task, status: 'paused' } });
  resumeTask.mockResolvedValue({ task });
  runTask.mockResolvedValue({ accepted: true });
  deleteTask.mockResolvedValue({ ok: true });
});

describe('ScheduledTasksPage', () => {
  it('blocks non-admins', async () => {
    renderWithContext(false);
    expect((await screen.findByRole('alert')).textContent).toContain('无权限');
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('loads tasks and supports create pause run delete and logs', async () => {
    renderWithContext(true);
    expect(await screen.findByRole('heading', { name: '晨报' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '新增任务' }));
    fireEvent.change(screen.getByLabelText('任务名'), { target: { value: '晚报' } });
    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '总结' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createTask).toHaveBeenCalled());
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
});
