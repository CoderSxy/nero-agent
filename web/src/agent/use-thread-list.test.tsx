import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadList } from './use-thread-list';

const listScopedThreads = vi.fn();
const setInitialThreadTitle = vi.fn();
vi.mock('./thread-scope', () => ({
  listScopedThreads: (...args: unknown[]) => listScopedThreads(...args),
  setInitialThreadTitle: (...args: unknown[]) => setInitialThreadTitle(...args),
  promptTitle: (text: string) => text.trim().replace(/\s+/g, ' ').slice(0, 32),
}));
vi.mock('./client', () => ({ AGENT_ID: 'agent', client: {} }));

beforeEach(() => {
  vi.clearAllMocks();
  listScopedThreads.mockResolvedValue([{ id: 'new', title: '新会话', resourceId: 'agent' }]);
  setInitialThreadTitle.mockResolvedValue(undefined);
});

describe('thread list titles', () => {
  it('shows the first submitted message before persistence and keeps it across a stale refresh', async () => {
    const { result } = renderHook(() => useThreadList('agent'));
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    act(() => result.current.previewFirstMessageTitle('new', '  第一条   消息  '));
    expect(result.current.threads[0].title).toBe('第一条 消息');
    await act(async () => { await result.current.refresh(); });
    expect(result.current.threads[0].title).toBe('第一条 消息');
    await act(async () => { await result.current.confirmFirstMessageTitle('new', '第一条 消息'); });
    expect(setInitialThreadTitle).toHaveBeenCalledWith('new', 'agent', '第一条 消息');
  });

  it('does not change an already named conversation', async () => {
    listScopedThreads.mockResolvedValue([{ id: 'old', title: '自定义标题', resourceId: 'agent' }]);
    const { result } = renderHook(() => useThreadList('agent'));
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    act(() => result.current.previewFirstMessageTitle('old', '新消息'));
    expect(result.current.threads[0].title).toBe('自定义标题');
    await act(async () => { await result.current.confirmFirstMessageTitle('old', '新消息'); });
    expect(setInitialThreadTitle).not.toHaveBeenCalled();
  });
});
