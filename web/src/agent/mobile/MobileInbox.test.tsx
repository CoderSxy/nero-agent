import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MobileInbox } from './MobileInbox';

afterEach(cleanup);

it('opens the three live cards and leaves the fourth card disabled', () => {
  const navigate = vi.fn();
  render(<MobileInbox threads={[{ id: 'one', title: '第一段会话', updatedAt: '2026-10-16T00:00:00Z' }]}
    source="default" onSourceChange={vi.fn()} onNavigate={navigate} onOpenThread={vi.fn()}
    loading={false} error={null} composer={<div>输入区</div>} />);
  fireEvent.click(screen.getByRole('button', { name: /历史对话/ }));
  fireEvent.click(screen.getByRole('button', { name: '文件管理' }));
  fireEvent.click(screen.getByRole('button', { name: '模型列表' }));
  expect(navigate.mock.calls.map(([path]) => path)).toEqual(['/history', '/files', '/models']);
  expect(screen.getByRole('button', { name: '敬请期待' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('第一段会话')).toBeTruthy();
});

it('switches the recent source and opens a recent thread', () => {
  const change = vi.fn();
  const open = vi.fn();
  render(<MobileInbox threads={[{ id: 'scheduled-1', title: '自动整理', updatedAt: '2026-10-16T00:00:00Z' }]}
    source="schedule" onSourceChange={change} onNavigate={vi.fn()} onOpenThread={open}
    loading={false} error={null} composer={<div>输入区</div>} />);
  fireEvent.click(screen.getByRole('tab', { name: '最近会话' }));
  expect(change).toHaveBeenCalledWith('default');
  fireEvent.click(screen.getByRole('button', { name: /自动整理/ }));
  expect(open).toHaveBeenCalledWith('scheduled-1');
});
