import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useThreadList } from './use-thread-list';

const listScopedThreads = vi.fn();
const createMemoryThread = vi.fn();
vi.mock('./thread-scope', () => ({ listScopedThreads: (...args: unknown[]) => listScopedThreads(...args) }));
vi.mock('./client', () => ({ AGENT_ID: 'agent', client: { createMemoryThread: (...args: unknown[]) => createMemoryThread(...args) } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('thread list hook', () => {
  it('creates a scoped thread and refreshes the list', async () => {
    listScopedThreads.mockResolvedValue([{ id: 'new', resourceId: 'agent' }]);
    createMemoryThread.mockResolvedValue({ id: 'new', resourceId: 'agent' });
    const { result } = renderHook(() => useThreadList('agent'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const models = { chatModel: 'deepseek/deepseek-v4-flash', memoryModel: 'deepseek/deepseek-v4-pro' };
    expect(await result.current.createThread(models)).toEqual({ id: 'new', resourceId: 'agent' });
    expect(createMemoryThread).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent', resourceId: 'agent',
      metadata: { neroAgentModels: models },
    }));
    expect(listScopedThreads).toHaveBeenCalledTimes(2);
  });
});
