import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThreadSidebar } from './ThreadSidebar';

afterEach(cleanup);

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
