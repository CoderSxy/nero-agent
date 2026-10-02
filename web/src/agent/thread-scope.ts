import type { ListMemoryThreadsResponse } from '@mastra/client-js';
import { AGENT_ID, client } from './client';

export type Thread = ListMemoryThreadsResponse['threads'][number];

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
    if (thread.title?.trim()) return thread;
    try {
      const result = await client.getMemoryThread({ threadId: thread.id, agentId: AGENT_ID })
        .listMessages({ agentId: AGENT_ID, resourceId, perPage: 1,
          orderBy: { field: 'createdAt', direction: 'ASC' } });
      const content = result.messages[0]?.content;
      const firstText = typeof content === 'string' ? content : content?.parts?.find(part => part.type === 'text')?.text;
      return { ...thread, title: firstText?.trim().slice(0, 32) || '新会话' };
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
