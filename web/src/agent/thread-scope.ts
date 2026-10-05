import type { ListMemoryThreadsResponse } from '@mastra/client-js';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { AGENT_ID, client } from './client';

export type Thread = ListMemoryThreadsResponse['threads'][number];

export function neighborAfterDeletion(threads: Pick<Thread, 'id'>[], deletedId: string): string | null {
  const index = threads.findIndex(thread => thread.id === deletedId);
  if (index < 0) return null;
  return threads[index + 1]?.id ?? threads[index - 1]?.id ?? null;
}

export async function deleteScopedThread(threadId: string, resourceId: string): Promise<void> {
  const thread = client.getMemoryThread({ threadId, agentId: AGENT_ID });
  const current = await thread.get();
  if (current.resourceId !== resourceId) throw new Error('会话不存在或无权访问');
  await thread.delete();
}

export async function renameScopedThread(threadId: string, resourceId: string, title: string): Promise<void> {
  const nextTitle = title.trim();
  if (!nextTitle) throw new Error('会话名称不能为空');
  const thread = client.getMemoryThread({ threadId, agentId: AGENT_ID });
  const current = await thread.get();
  if (current.resourceId !== resourceId) throw new Error('会话不存在或无权访问');
  await thread.update({ title: nextTitle,
    metadata: { ...current.metadata, neroAgentTitleSource: 'manual' } });
}

export async function listScopedThreads(resourceId: string): Promise<Thread[]> {
  const allThreads: Thread[] = [];
  let page = 0;
  let hasMore = true;
  while (hasMore) {
    const result = await client.listMemoryThreads({ agentId: AGENT_ID, resourceId, page, perPage: 100 });
    allThreads.push(...result.threads);
    hasMore = !!result.hasMore && result.threads.length > 0;
    page += 1;
  }
  const threads = allThreads.filter(thread => thread.resourceId === resourceId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return Promise.all(threads.map(async thread => {
    if (thread.title?.trim() && thread.title !== '新会话') return thread;
    if (thread.metadata?.neroAgentTitleSource === 'manual') return thread;
    try {
      const result = await client.getMemoryThread({ threadId: thread.id, agentId: AGENT_ID })
        .listMessages({ agentId: AGENT_ID, resourceId, perPage: 1,
          orderBy: { field: 'createdAt', direction: 'ASC' }, filter: { roles: ['user'] } });
      const content = (result.messages as MastraDBMessage[]).find(message => message.role === 'user')?.content;
      const firstText = typeof content === 'string' ? content : content?.parts?.find(part => part.type === 'text')?.text;
      const title = firstText?.trim().replace(/\s+/g, ' ').slice(0, 32);
      if (!title) return { ...thread, title: thread.title?.trim() || '新会话' };
      const memoryThread = client.getMemoryThread({ threadId: thread.id, agentId: AGENT_ID });
      const current = await memoryThread.get();
      if (current.resourceId !== resourceId) return thread;
      if (current.metadata?.neroAgentTitleSource === 'manual' ||
        (current.title?.trim() && current.title !== '新会话')) return { ...thread, title: current.title };
      await memoryThread.update({ title });
      return { ...thread, title };
    } catch { return { ...thread, title: '新会话' }; }
  }));
}

export async function loadScopedThread(threadId: string, resourceId: string) {
  const thread = await client.getMemoryThread({ threadId, agentId: AGENT_ID }).get();
  if (thread.resourceId !== resourceId) throw new Error('会话不存在或无权访问');
  const messages = [];
  let page = 0;
  let hasMore = true;
  while (hasMore) {
    const result = await client.getMemoryThread({ threadId, agentId: AGENT_ID })
      .listMessages({ agentId: AGENT_ID, resourceId, page, perPage: 100,
        orderBy: { field: 'createdAt', direction: 'ASC' } });
    messages.push(...result.messages);
    hasMore = !!result.hasMore && result.messages.length > 0;
    page += 1;
  }
  return { thread, messages };
}
