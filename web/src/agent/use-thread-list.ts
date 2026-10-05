import { useCallback, useEffect, useState } from 'react';
import { AGENT_ID, client } from './client';
import { deleteScopedThread, listScopedThreads, renameScopedThread, type Thread } from './thread-scope';
import { withThreadModels, type ModelSettings } from './model-settings';

export function useThreadList(resourceId: string) {
  // resourceId is the authenticated user UUID from /auth/me, not a client-chosen owner.
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setThreads(await listScopedThreads(resourceId)); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加载会话失败'); }
    finally { setLoading(false); }
  }, [resourceId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const createThread = useCallback(async (models: ModelSettings) => {
    const thread = await client.createMemoryThread({ agentId: AGENT_ID, resourceId,
      title: '新会话', metadata: withThreadModels(null, models) });
    await refresh();
    return thread;
  }, [refresh, resourceId]);
  const deleteThread = useCallback(async (threadId: string) => {
    await deleteScopedThread(threadId, resourceId);
    setThreads(current => current.filter(thread => thread.id !== threadId));
    await refresh();
  }, [refresh, resourceId]);
  const renameThread = useCallback(async (threadId: string, title: string) => {
    await renameScopedThread(threadId, resourceId, title);
    setThreads(current => current.map(thread => thread.id === threadId ? { ...thread, title: title.trim() } : thread));
    await refresh();
  }, [refresh, resourceId]);
  return { threads, loading, error, refresh, createThread, deleteThread, renameThread };
}
