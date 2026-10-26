import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HistoryBoundary } from './HistoryBoundary';

describe('HistoryBoundary', () => {
  it('renders load-earlier and complete states', () => {
    const onLoadBefore = vi.fn();
    const { rerender } = render(
      <HistoryBoundary hasBefore hasAfter={false} onLoadBefore={onLoadBefore} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '加载更早的对话' }));
    expect(onLoadBefore).toHaveBeenCalledOnce();

    rerender(<HistoryBoundary hasBefore={false} hasAfter={false} />);
    expect(screen.getByTestId('history-complete').textContent).toBe('已加载全部历史');
  });

  it('shows gap actions', () => {
    const onGoLatest = vi.fn();
    render(
      <HistoryBoundary hasBefore={false} hasAfter gap onGoLatest={onGoLatest} onLoadAfter={() => undefined} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '回到最新消息' }));
    expect(onGoLatest).toHaveBeenCalledOnce();
  });
});
