import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listScopedThreads, loadScopedThread } from './thread-scope';

const listMemoryThreads = vi.fn();
const get = vi.fn();
const listMessages = vi.fn();
vi.mock('./client', () => ({ AGENT_ID: 'agent', client: {
  listMemoryThreads: (...args: unknown[]) => listMemoryThreads(...args),
  getMemoryThread: () => ({ get, listMessages }),
} }));

beforeEach(() => { vi.clearAllMocks(); listMessages.mockResolvedValue({ messages: [] }); });

describe('Studio thread scope', () => {
  it('lists only the shared resource and sorts recent updates first', async () => {
    listMemoryThreads.mockResolvedValue({ threads: [
      { id: 'old', resourceId: 'agent', updatedAt: '2026-09-01' },
      { id: 'other', resourceId: 'local-user', updatedAt: '2026-09-30' },
      { id: 'new', resourceId: 'agent', updatedAt: '2026-09-29' },
    ] });
    expect((await listScopedThreads()).map(thread => thread.id)).toEqual(['new', 'old']);
    expect(listMemoryThreads).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent', resourceId: 'agent' }));
  });
  it('rejects a thread owned by another resource before loading messages', async () => {
    get.mockResolvedValue({ id: 'other', resourceId: 'local-user' });
    await expect(loadScopedThread('other')).rejects.toThrow('无权访问');
    expect(listMessages).not.toHaveBeenCalled();
  });
  it('loads messages only after ownership matches', async () => {
    get.mockResolvedValue({ id: 'mine', resourceId: 'agent' });
    listMessages.mockResolvedValue({ messages: [{ id: 'one' }] });
    expect((await loadScopedThread('mine')).messages).toEqual([{ id: 'one' }]);
    expect(listMessages).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'agent' }));
  });
  it('continues through paginated message history in chronological order', async () => {
    get.mockResolvedValue({ id: 'mine', resourceId: 'agent' });
    listMessages.mockResolvedValueOnce({ messages: [{ id: 'first' }], hasMore: true })
      .mockResolvedValueOnce({ messages: [{ id: 'second' }], hasMore: false });
    expect((await loadScopedThread('mine')).messages.map(message => message.id)).toEqual(['first', 'second']);
    expect(listMessages).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 1 }));
  });
});
