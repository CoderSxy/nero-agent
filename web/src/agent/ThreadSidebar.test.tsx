import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
import { ThreadSidebar } from './ThreadSidebar';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('keeps the logo and settings outside the scrolling conversation list', () => {
  const { container } = render(<ThreadSidebar threads={[]} loading={false} error={null}
    onNew={vi.fn()} onSelect={vi.fn()}
    theme="dark" onThemeChange={vi.fn()} />);
  const scroll = container.querySelector('.thread-scroll');
  expect(scroll).toBeTruthy();
  expect(scroll?.contains(container.querySelector('.brand'))).toBe(false);
  expect(scroll?.contains(screen.getByRole('button', { name: '设置' }))).toBe(false);
});

it('shows a clean new-conversation action and marks the active thread', () => {
  const threads = [{ id: 'a', title: '当前会话', resourceId: 'agent', updatedAt: '2026-10-05' },
    { id: 'b', title: '其他会话', resourceId: 'agent', updatedAt: '2026-10-04' }] as never;
  render(<ThreadSidebar threads={threads} currentId="a" loading={false} error={null}
    onNew={vi.fn()} onSelect={vi.fn()} theme="dark" onThemeChange={vi.fn()} />);
  expect(screen.getByRole('button', { name: '新建会话' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '＋ 新建会话' })).toBeNull();
  expect(screen.getByRole('button', { name: '当前会话' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('button', { name: '其他会话' }).getAttribute('aria-current')).toBeNull();
});

it('starts grouped and switches between time groups and the ordinary list', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 7, 12));
  const threads = [
    { id: 'a', title: '今天的会话', resourceId: 'agent', updatedAt: '2026-10-07T11:45:00' },
    { id: 'b', title: '较早的会话', resourceId: 'agent', updatedAt: '2026-08-01T09:00:00' },
  ] as never;
  render(<ThreadSidebar threads={threads} currentId="a" loading={false} error={null}
    onNew={vi.fn()} onSelect={vi.fn()} theme="dark" onThemeChange={vi.fn()} />);
  expect(screen.getByText('今天')).toBeTruthy();
  expect(screen.getByText('2026-08')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '切换为普通列表' }));
  expect(screen.queryByText('今天')).toBeNull();
  expect(screen.queryByText('2026-08')).toBeNull();
  expect(screen.getByText('15 分')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '切换为时间分组' }));
  expect(screen.getByText('今天')).toBeTruthy();
  vi.useRealTimers();
});

it('shows a per-thread menu and requires confirmation before deletion', async () => {
  const onDelete = vi.fn().mockResolvedValue(undefined);
  const threads = [{ id: 'a', title: '会话 A', resourceId: 'agent', updatedAt: '2026-10-05' }] as never;
  render(<ThreadSidebar threads={threads} currentId="a" loading={false} error={null}
    onNew={vi.fn()} onSelect={vi.fn()} onDelete={onDelete}
    theme="dark" onThemeChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '会话 A 的更多操作' }));
  expect(document.querySelector('.thread-scroll')?.contains(screen.getByRole('menu'))).toBe(false);
  fireEvent.click(screen.getByRole('menuitem', { name: '删除会话' }));
  expect(onDelete).not.toHaveBeenCalled();
  expect(screen.getByRole('alertdialog', { name: '删除会话' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '会话 A 的更多操作' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '删除会话' }));
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(onDelete).toHaveBeenCalledWith('a'));
});

it('keeps confirmation open and shows the error when deletion fails', async () => {
  const onDelete = vi.fn().mockRejectedValue(new Error('删除失败，请重试'));
  const threads = [{ id: 'a', title: '会话 A', resourceId: 'agent', updatedAt: '2026-10-05' }] as never;
  render(<ThreadSidebar threads={threads} currentId="a" loading={false} error={null}
    onNew={vi.fn()} onSelect={vi.fn()} onDelete={onDelete}
    theme="dark" onThemeChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '会话 A 的更多操作' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '删除会话' }));
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect((await screen.findByRole('alert')).textContent).toContain('删除失败');
  expect(screen.getByRole('alertdialog', { name: '删除会话' })).toBeTruthy();
});

it('shows rename above delete and saves a nonempty edited title', async () => {
  const onRename = vi.fn().mockResolvedValue(undefined);
  const threads = [{ id: 'a', title: '原会话', resourceId: 'agent', updatedAt: '2026-10-05' }] as never;
  render(<ThreadSidebar threads={threads} loading={false} error={null}
    onNew={vi.fn()} onSelect={vi.fn()} onRename={onRename}
    theme="dark" onThemeChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '原会话 的更多操作' }));
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['修改会话名', '删除会话']);
  fireEvent.click(screen.getByRole('menuitem', { name: '修改会话名' }));
  const input = screen.getByRole('textbox', { name: '会话名称' });
  fireEvent.change(input, { target: { value: '  新标题  ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(onRename).toHaveBeenCalledWith('a', '新标题'));
});

it('shows history search beside the heading and opens the dialog from the icon', async () => {
  const ensureRecent = vi.fn();
  const threads = [{ id: 'a', title: '会话', resourceId: 'agent', updatedAt: '2026-10-05' }] as never;
  render(<ThreadSidebar threads={threads} loading={false} error={null}
    onNew={vi.fn()} onSelect={vi.fn()} theme="dark" onThemeChange={vi.fn()}
    search={{
      documents: [], scope: 'recent', recentStatus: 'ready', fullStatus: 'idle',
      recentProgress: { completed: 0, total: 0 }, fullProgress: { completed: 0, total: 0 },
      recentFailedCount: 0, fullFailedCount: 0, ensureRecent, cancelRecent: vi.fn(),
      loadAll: vi.fn(), retryRecent: vi.fn(), retryFull: vi.fn(), invalidateThread: vi.fn(),
    }} onSearchSelect={vi.fn()} />);
  const launcher = screen.getByRole('button', { name: '搜索历史对话' });
  expect(launcher.closest('.thread-history-heading')).toBeTruthy();
  fireEvent.click(launcher);
  expect(await screen.findByRole('dialog', { name: '搜索历史对话' })).toBeTruthy();
  expect(ensureRecent).toHaveBeenCalled();
});

it('toggles history search with Ctrl/Cmd+K at document level', async () => {
  const threads = [{ id: 'a', title: '会话', resourceId: 'agent', updatedAt: '2026-10-05' }] as never;
  render(<ThreadSidebar threads={threads} loading={false} error={null}
    onNew={vi.fn()} onSelect={vi.fn()} theme="dark" onThemeChange={vi.fn()}
    search={{
      documents: [], scope: 'recent', recentStatus: 'ready', fullStatus: 'idle',
      recentProgress: { completed: 0, total: 0 }, fullProgress: { completed: 0, total: 0 },
      recentFailedCount: 0, fullFailedCount: 0, ensureRecent: vi.fn(), cancelRecent: vi.fn(),
      loadAll: vi.fn(), retryRecent: vi.fn(), retryFull: vi.fn(), invalidateThread: vi.fn(),
    }} onSearchSelect={vi.fn()} />);
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  expect(await screen.findByRole('dialog', { name: '搜索历史对话' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'k', metaKey: true });
  expect(screen.queryByRole('dialog', { name: '搜索历史对话' })).toBeNull();
});

it('closes history search with Ctrl/Cmd+K when focus is in the search input', async () => {
  const threads = [{ id: 'a', title: '会话', resourceId: 'agent', updatedAt: '2026-10-05' }] as never;
  render(<ThreadSidebar threads={threads} loading={false} error={null}
    onNew={vi.fn()} onSelect={vi.fn()} theme="dark" onThemeChange={vi.fn()}
    search={{
      documents: [], scope: 'recent', recentStatus: 'ready', fullStatus: 'idle',
      recentProgress: { completed: 0, total: 0 }, fullProgress: { completed: 0, total: 0 },
      recentFailedCount: 0, fullFailedCount: 0, ensureRecent: vi.fn(), cancelRecent: vi.fn(),
      loadAll: vi.fn(), retryRecent: vi.fn(), retryFull: vi.fn(), invalidateThread: vi.fn(),
    }} onSearchSelect={vi.fn()} />);
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  const input = await screen.findByLabelText('搜索历史对话中的问题和回答');
  input.focus();
  fireEvent.keyDown(input, { key: 'k', ctrlKey: true, bubbles: true });
  expect(screen.queryByRole('dialog', { name: '搜索历史对话' })).toBeNull();
});

it('opens history search with Ctrl/Cmd+K while the chat composer has focus', async () => {
  const threads = [{ id: 'a', title: '会话', resourceId: 'agent', updatedAt: '2026-10-05' }] as never;
  const composer = document.createElement('textarea');
  document.body.append(composer);
  render(<ThreadSidebar threads={threads} loading={false} error={null}
    onNew={vi.fn()} onSelect={vi.fn()} theme="dark" onThemeChange={vi.fn()}
    search={{
      documents: [], scope: 'recent', recentStatus: 'ready', fullStatus: 'idle',
      recentProgress: { completed: 0, total: 0 }, fullProgress: { completed: 0, total: 0 },
      recentFailedCount: 0, fullFailedCount: 0, ensureRecent: vi.fn(), cancelRecent: vi.fn(),
      loadAll: vi.fn(), retryRecent: vi.fn(), retryFull: vi.fn(), invalidateThread: vi.fn(),
    }} onSearchSelect={vi.fn()} />);
  try {
    composer.focus();
    fireEvent.keyDown(composer, { key: 'k', metaKey: true, bubbles: true });
    expect(await screen.findByRole('dialog', { name: '搜索历史对话' })).toBeTruthy();
  } finally {
    composer.remove();
  }
});
