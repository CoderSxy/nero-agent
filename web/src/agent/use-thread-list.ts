import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_ID, client } from './client';
import { deleteScopedThread, listScopedThreads, promptTitle, renameScopedThread,
  setInitialThreadTitle, type Thread } from './thread-scope';
import { withThreadModels, type ModelSettings } from './model-settings';

export function useThreadList(resourceId: string) {
  // resourceId is the authenticated user UUID from /auth/me, not a client-chosen owner.
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const titlePreviews = useRef(new Map<string, string>());
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const loaded = await listScopedThreads(resourceId);
      if (sequence !== refreshSequence.current) return;
      setThreads(loaded.map(thread => {
        const preview = titlePreviews.current.get(thread.id);
        if (!preview) return thread;
        if (thread.title?.trim() && thread.title !== '新会话') {
          titlePreviews.current.delete(thread.id);
          return thread;
        }
        return { ...thread, title: preview };
      }));
      setError(null);
    } catch (cause) {
      if (sequence === refreshSequence.current)
        setError(cause instanceof Error ? cause.message : '加载会话失败');
    } finally { if (sequence === refreshSequence.current) setLoading(false); }
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
    titlePreviews.current.delete(threadId);
    setThreads(current => current.filter(thread => thread.id !== threadId));
    await refresh();
  }, [refresh, resourceId]);
  const renameThread = useCallback(async (threadId: string, title: string) => {
    await renameScopedThread(threadId, resourceId, title);
    titlePreviews.current.delete(threadId);
    setThreads(current => current.map(thread => thread.id === threadId ? { ...thread, title: title.trim() } : thread));
    await refresh();
  }, [refresh, resourceId]);
  const previewFirstMessageTitle = useCallback((threadId: string, text: string) => {
    const title = promptTitle(text);
    if (!title || titlePreviews.current.has(threadId)) return;
    const current = threads.find(thread => thread.id === threadId);
    if (!current || (current.title?.trim() && current.title !== '新会话') ||
      current.metadata?.neroAgentTitleSource === 'manual') return;
    titlePreviews.current.set(threadId, title);
    setThreads(items => items.map(thread => thread.id === threadId ? { ...thread, title } : thread));
  }, [threads]);
  const confirmFirstMessageTitle = useCallback(async (threadId: string, text: string) => {
    if (titlePreviews.current.get(threadId) !== promptTitle(text)) return;
    await setInitialThreadTitle(threadId, resourceId, text);
    await refresh();
  }, [refresh, resourceId]);
  const discardFirstMessageTitle = useCallback((threadId: string, text: string) => {
    if (titlePreviews.current.get(threadId) !== promptTitle(text)) return;
    titlePreviews.current.delete(threadId);
    void refresh();
  }, [refresh]);
  return { threads, loading, error, refresh, createThread, deleteThread, renameThread,
    previewFirstMessageTitle, confirmFirstMessageTitle, discardFirstMessageTitle };
}
