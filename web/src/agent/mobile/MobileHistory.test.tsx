import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MobileHistory } from './MobileHistory';

afterEach(cleanup);

it('shows filtered threads and opens a selected conversation', () => {
  const open = vi.fn();
  render(<MobileHistory threads={[{ id: 'one', title: '方案讨论', updatedAt: '2026-10-16T00:00:00Z' }]}
    source="default" onSourceChange={vi.fn()} onOpenThread={open} loading={false} error={null} />);
  fireEvent.click(screen.getByRole('button', { name: '打开会话 方案讨论' }));
  expect(open).toHaveBeenCalledWith('one');
  expect(screen.getByRole('tablist', { name: '会话列表类型' })).toBeTruthy();
});

it('shows an empty scheduled state and switches back to regular conversations', () => {
  const change = vi.fn();
  render(<MobileHistory threads={[]} source="schedule" onSourceChange={change}
    onOpenThread={vi.fn()} loading={false} error={null} />);
  expect(screen.getByText('暂无调度会话')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: '历史对话' }));
  expect(change).toHaveBeenCalledWith('default');
});
