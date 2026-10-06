import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listScopedThreads, loadScopedThread, neighborAfterDeletion, deleteScopedThread, renameScopedThread,
  setInitialThreadTitle } from './thread-scope';

const listMemoryThreads = vi.fn();
const get = vi.fn();
const listMessages = vi.fn();
const deleteThread = vi.fn();
const update = vi.fn();
vi.mock('./client', () => ({ AGENT_ID: 'agent', client: {
  listMemoryThreads: (...args: unknown[]) => listMemoryThreads(...args),
  getMemoryThread: () => ({ get, listMessages, delete: deleteThread, update }),
} }));

beforeEach(() => { vi.clearAllMocks(); listMessages.mockResolvedValue({ messages: [] }); });

describe('Studio thread scope', () => {
  it('selects the next visible thread, then previous, then new conversation after deletion', () => {
    const threads = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never;
    expect(neighborAfterDeletion(threads, 'a')).toBe('b');
    expect(neighborAfterDeletion(threads, 'b')).toBe('c');
    expect(neighborAfterDeletion(threads, 'c')).toBe('b');
    expect(neighborAfterDeletion([{ id: 'a' }] as never, 'a')).toBeNull();
  });
  it('checks ownership before deleting a thread', async () => {
    get.mockResolvedValueOnce({ id: 'other', resourceId: 'other-user' })
      .mockResolvedValueOnce({ id: 'mine', resourceId: 'agent' });
    await expect(deleteScopedThread('other', 'agent')).rejects.toThrow('无权访问');
    expect(deleteThread).not.toHaveBeenCalled();
    await deleteScopedThread('mine', 'agent');
    expect(deleteThread).toHaveBeenCalledWith();
  });
  it('lists only the shared resource and sorts recent updates first', async () => {
    listMemoryThreads.mockResolvedValue({ threads: [
      { id: 'old', resourceId: 'agent', updatedAt: '2026-09-01' },
      { id: 'other', resourceId: 'local-user', updatedAt: '2026-09-30' },
      { id: 'new', resourceId: 'agent', updatedAt: '2026-09-29' },
    ] });
    expect((await listScopedThreads('agent')).map(thread => thread.id)).toEqual(['new', 'old']);
    expect(listMemoryThreads).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent', resourceId: 'agent' }));
  });
  it('uses the first user message as the title of a default-named conversation', async () => {
    listMemoryThreads.mockResolvedValue({ threads: [{ id: 'mine', title: '新会话', resourceId: 'agent', updatedAt: '2026-10-05' }] });
    get.mockResolvedValue({ id: 'mine', title: '新会话', resourceId: 'agent', metadata: { other: 'keep' } });
    listMessages.mockResolvedValue({ messages: [
      { role: 'assistant', content: { parts: [{ type: 'text', text: '欢迎' }] } },
      { role: 'user', content: { parts: [{ type: 'text', text: '帮我规划这周的工作' }] } },
    ] });
    update.mockResolvedValue({ id: 'mine', title: '帮我规划这周的工作', resourceId: 'agent' });
    expect((await listScopedThreads('agent'))[0].title).toBe('帮我规划这周的工作');
    expect(update).toHaveBeenCalledWith({ title: '帮我规划这周的工作' });
  });
  it('uses the first user thread signal as the title', async () => {
    listMemoryThreads.mockResolvedValue({ threads: [{ id: 'mine', title: '新会话', resourceId: 'agent', updatedAt: '2026-10-06' }] });
    get.mockResolvedValue({ id: 'mine', title: '新会话', resourceId: 'agent', metadata: {} });
    listMessages.mockResolvedValue({ messages: [
      { role: 'signal', type: 'notification', content: { format: 2, parts: [{ type: 'text', text: '系统通知' }] } },
      { role: 'signal', type: 'user', content: { format: 2, parts: [
        { type: 'text', text: '帮我写一份排序算法面试题' },
      ], metadata: { signal: { type: 'user', tagName: 'user' } } } },
    ], hasMore: false });
    update.mockResolvedValue({ id: 'mine', title: '帮我写一份排序算法面试题', resourceId: 'agent' });
    expect((await listScopedThreads('agent'))[0].title).toBe('帮我写一份排序算法面试题');
    expect(listMessages).toHaveBeenCalledWith(expect.objectContaining({ filter: { roles: ['user', 'signal'] } }));
    expect(update).toHaveBeenCalledWith({ title: '帮我写一份排序算法面试题' });
  });

  it('continues past non-user signals to find the earliest user prompt', async () => {
    listMemoryThreads.mockResolvedValue({ threads: [{ id: 'mine', title: '新会话', resourceId: 'agent', updatedAt: '2026-10-06' }] });
    get.mockResolvedValue({ id: 'mine', title: '新会话', resourceId: 'agent', metadata: {} });
    listMessages.mockResolvedValueOnce({ messages: [{ role: 'signal', type: 'notification',
      content: { format: 2, parts: [{ type: 'text', text: '系统通知' }] } }], hasMore: true })
      .mockResolvedValueOnce({ messages: [{ role: 'signal', type: 'user-message',
        content: { format: 2, parts: [{ type: 'text', text: '第一个问题' }],
          metadata: { signal: { type: 'user-message', tagName: 'user' } } } }], hasMore: false });
    update.mockResolvedValue({ id: 'mine', title: '第一个问题', resourceId: 'agent' });
    expect((await listScopedThreads('agent'))[0].title).toBe('第一个问题');
    expect(listMessages).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 1 }));
  });
  it('preserves a manually renamed conversation when refreshing the list', async () => {
    listMemoryThreads.mockResolvedValue({ threads: [{ id: 'mine', title: '新会话', resourceId: 'agent', updatedAt: '2026-10-05', metadata: { neroAgentTitleSource: 'manual' } }] });
    expect((await listScopedThreads('agent'))[0].title).toBe('新会话');
    expect(listMessages).not.toHaveBeenCalled();
  });
  it('renames only owned conversations and preserves existing metadata', async () => {
    get.mockResolvedValueOnce({ id: 'other', resourceId: 'other-user' })
      .mockResolvedValueOnce({ id: 'mine', title: '旧名称', resourceId: 'agent', metadata: { other: 'keep' } });
    await expect(renameScopedThread('other', 'agent', '新名称')).rejects.toThrow('无权访问');
    expect(update).not.toHaveBeenCalled();
    await renameScopedThread('mine', 'agent', '  我的会话  ');
    expect(update).toHaveBeenCalledWith({ title: '我的会话', metadata: { other: 'keep', neroAgentTitleSource: 'manual' } });
  });
  it('sets the first prompt title immediately while preserving later manual titles', async () => {
    get.mockResolvedValueOnce({ id: 'mine', resourceId: 'agent', title: '新会话', metadata: {} })
      .mockResolvedValueOnce({ id: 'mine', resourceId: 'agent', title: '手动标题',
        metadata: { neroAgentTitleSource: 'manual' } });
    await setInitialThreadTitle('mine', 'agent', '  第一条   问题  ');
    expect(update).toHaveBeenCalledWith({ title: '第一条 问题' });
    await setInitialThreadTitle('mine', 'agent', '第二条问题');
    expect(update).toHaveBeenCalledTimes(1);
  });
  it('rejects a thread owned by another resource before loading messages', async () => {
    get.mockResolvedValue({ id: 'other', resourceId: 'local-user' });
    await expect(loadScopedThread('other', 'agent')).rejects.toThrow('无权访问');
    expect(listMessages).not.toHaveBeenCalled();
  });
  it('loads messages only after ownership matches', async () => {
    get.mockResolvedValue({ id: 'mine', resourceId: 'agent' });
    listMessages.mockResolvedValue({ messages: [{ id: 'one' }] });
    expect((await loadScopedThread('mine', 'agent')).messages).toEqual([{ id: 'one' }]);
    expect(listMessages).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'agent' }));
  });
  it('continues through paginated message history in chronological order', async () => {
    get.mockResolvedValue({ id: 'mine', resourceId: 'agent' });
    listMessages.mockResolvedValueOnce({ messages: [{ id: 'first' }], hasMore: true })
      .mockResolvedValueOnce({ messages: [{ id: 'second' }], hasMore: false });
    expect((await loadScopedThread('mine', 'agent')).messages.map(message => message.id)).toEqual(['first', 'second']);
    expect(listMessages).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 1 }));
  });
});
