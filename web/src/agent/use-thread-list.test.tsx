import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useThreadList } from './use-thread-list';

const listScopedThreads = vi.fn();
const deleteScopedThread = vi.fn();
const createMemoryThread = vi.fn();
vi.mock('./thread-scope', () => ({
  listScopedThreads: (...args: unknown[]) => listScopedThreads(...args),
  deleteScopedThread: (...args: unknown[]) => deleteScopedThread(...args),
}));
vi.mock('./client', () => ({ AGENT_ID: 'agent', client: { createMemoryThread: (...args: unknown[]) => createMemoryThread(...args) } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('thread list hook', () => {
  it('creates a scoped thread and refreshes the list', async () => {
    listScopedThreads.mockResolvedValue([{ id: 'new', resourceId: 'agent' }]);
    createMemoryThread.mockResolvedValue({ id: 'new', resourceId: 'agent' });
    const { result } = renderHook(() => useThreadList('agent'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const models = {
      chatModel: 'public:11111111-1111-4111-8111-111111111111' as const,
      memoryModel: 'private:22222222-2222-4222-8222-222222222222' as const,
    };
    expect(await result.current.createThread(models)).toEqual({ id: 'new', resourceId: 'agent' });
    expect(createMemoryThread).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent', resourceId: 'agent',
      metadata: { neroAgentModels: models },
    }));
    expect(listScopedThreads).toHaveBeenCalledTimes(2);
  });
  it('deletes a scoped thread and refreshes the list only after deletion succeeds', async () => {
    listScopedThreads.mockResolvedValue([{ id: 'old', resourceId: 'agent' }]);
    deleteScopedThread.mockResolvedValue(undefined);
    const { result } = renderHook(() => useThreadList('agent'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await result.current.deleteThread('old');
    expect(deleteScopedThread).toHaveBeenCalledWith('old', 'agent');
    expect(listScopedThreads).toHaveBeenCalledTimes(2);
  });
  it('removes a deleted thread locally even if refreshing the list fails', async () => {
    listScopedThreads.mockResolvedValueOnce([{ id: 'old', resourceId: 'agent' }])
      .mockRejectedValueOnce(new Error('刷新失败'));
    deleteScopedThread.mockResolvedValue(undefined);
    const { result } = renderHook(() => useThreadList('agent'));
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    await result.current.deleteThread('old');
    await waitFor(() => expect(result.current.threads).toHaveLength(0));
  });
});
