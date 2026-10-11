import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
import { HistorySearchDialog } from './HistorySearchDialog';
import type { HistorySearchDocument } from './history-search-index';
import { RECENT_HISTORY_LIMIT } from './history-search-index';

function doc(overrides: Partial<HistorySearchDocument> = {}): HistorySearchDocument {
  return {
    threadId: 'thread-a',
    threadTitle: '会话 A',
    threadUpdatedAt: '2026-10-11T12:00:00.000Z',
    userMessageId: 'msg-user-1',
    questionText: '如何部署服务',
    answerText: '使用 docker compose 部署',
    ...overrides,
  };
}

function mockSearch(overrides: Record<string, unknown> = {}) {
  return {
    documents: [doc()],
    scope: 'recent' as const,
    recentStatus: 'ready' as const,
    fullStatus: 'idle' as const,
    recentProgress: { completed: 1, total: 1 },
    fullProgress: { completed: 0, total: 0 },
    recentFailedCount: 0,
    fullFailedCount: 0,
    ensureRecent: vi.fn(),
    cancelRecent: vi.fn(),
    loadAll: vi.fn(),
    retryRecent: vi.fn(),
    retryFull: vi.fn(),
    invalidateThread: vi.fn(),
    ...overrides,
  };
}

afterEach(() => cleanup());

it('calls ensureRecent when opened and focuses the search input', async () => {
  const search = mockSearch();
  const { rerender } = render(<HistorySearchDialog open={false} search={search}
    onClose={vi.fn()} onSelect={vi.fn()} threadCount={1} />);
  expect(search.ensureRecent).not.toHaveBeenCalled();
  rerender(<HistorySearchDialog open search={search} onClose={vi.fn()} onSelect={vi.fn()} threadCount={1} />);
  expect(search.ensureRecent).toHaveBeenCalled();
  const input = await screen.findByLabelText('搜索历史对话中的问题和回答');
  await waitFor(() => expect(document.activeElement).toBe(input));
});

it('shows empty guidance, results with source and total, and loading status', () => {
  const search = mockSearch({ documents: [], recentStatus: 'loading', recentProgress: { completed: 2, total: 5 } });
  render(<HistorySearchDialog open search={search} onClose={vi.fn()} onSelect={vi.fn()} threadCount={5} />);
  expect(screen.getByText(/输入关键词/)).toBeTruthy();
  const ready = mockSearch({
    documents: [
      doc({ questionText: 'alpha question', answerText: 'beta' }),
      doc({ threadId: 'b', userMessageId: 'm2', questionText: 'other', answerText: 'alpha answer hit' }),
    ],
  });
  cleanup();
  render(<HistorySearchDialog open search={ready} onClose={vi.fn()} onSelect={vi.fn()} threadCount={2} />);
  fireEvent.change(screen.getByLabelText('搜索历史对话中的问题和回答'), { target: { value: 'alpha' } });
  expect(screen.getByText('问题')).toBeTruthy();
  expect(screen.getByText('回答')).toBeTruthy();
  expect(screen.getByText(/共 2 条匹配/)).toBeTruthy();
  cleanup();
  render(<HistorySearchDialog open search={search} onClose={vi.fn()} onSelect={vi.fn()} threadCount={5} />);
  expect(screen.getByRole('status').textContent).toMatch(/2\s*\/\s*5/);
});

it('shows retry actions and load-all only when thread count exceeds recent limit', () => {
  const search = mockSearch({ recentStatus: 'error', recentFailedCount: 2 });
  render(<HistorySearchDialog open search={search} onClose={vi.fn()} onSelect={vi.fn()}
    threadCount={RECENT_HISTORY_LIMIT} />);
  expect(screen.queryByRole('button', { name: '加载全部会话内容' })).toBeNull();
  expect(screen.getByRole('button', { name: '重试加载' })).toBeTruthy();
  cleanup();
  const full = mockSearch({ fullStatus: 'error', fullFailedCount: 1, scope: 'recent' });
  render(<HistorySearchDialog open search={full} onClose={vi.fn()} onSelect={vi.fn()}
    threadCount={RECENT_HISTORY_LIMIT + 1} />);
  expect(screen.getByRole('button', { name: '加载全部会话内容' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: '重试加载' }).length).toBeGreaterThan(0);
});

it('closes on Escape and backdrop and restores launcher focus', async () => {
  const onClose = vi.fn();
  const launcher = document.createElement('button');
  launcher.setAttribute('aria-label', '搜索历史对话');
  document.body.append(launcher);
  launcher.focus();
  render(<HistorySearchDialog open search={mockSearch()} onClose={onClose} onSelect={vi.fn()}
    threadCount={1} returnFocusRef={{ current: launcher }} />);
  await screen.findByRole('dialog', { name: '搜索历史对话' });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(launcher));
  cleanup();
  onClose.mockClear();
  launcher.focus();
  render(<HistorySearchDialog open search={mockSearch()} onClose={onClose} onSelect={vi.fn()}
    threadCount={1} returnFocusRef={{ current: launcher }} />);
  fireEvent.click(document.querySelector('.history-search-backdrop')!);
  expect(onClose).toHaveBeenCalled();
  launcher.remove();
});

it('selects with Enter but ignores Enter during IME composition', () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const search = mockSearch({
    documents: [doc({ userMessageId: 'pick-me', questionText: 'needle text' })],
  });
  render(<HistorySearchDialog open search={search} onClose={onClose} onSelect={onSelect} threadCount={1} />);
  const input = screen.getByLabelText('搜索历史对话中的问题和回答');
  fireEvent.change(input, { target: { value: 'needle' } });
  const item = screen.getByRole('option', { name: /needle/i });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ userMessageId: 'pick-me' }));
  expect(onClose).toHaveBeenCalled();
});

it('cancels recent loading when closed while recent batch is active', () => {
  const search = mockSearch({ recentStatus: 'loading' });
  const { rerender } = render(<HistorySearchDialog open search={search} onClose={vi.fn()} onSelect={vi.fn()} threadCount={3} />);
  rerender(<HistorySearchDialog open={false} search={search} onClose={vi.fn()} onSelect={vi.fn()} threadCount={3} />);
  expect(search.cancelRecent).toHaveBeenCalled();
});
