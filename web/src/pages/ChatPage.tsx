import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AgentChatPanel } from '../components/AgentChatPanel';
import { LeftPanel } from '../components/LeftPanel';
import { createMastraClient } from '../lib/mastra-client';
import { sortThreads, type ThreadSummary } from '../lib/thread-label';

type MastraClient = ReturnType<typeof createMastraClient>;

export function ChatPage({ client }: { client?: MastraClient }) {
  const api = useMemo(() => client ?? createMastraClient(), [client]);
  const navigate = useNavigate();
  const { threadId } = useParams();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [listError, setListError] = useState<string>();
  const [banner, setBanner] = useState<string>();
  const [listReloadKey, setListReloadKey] = useState(0);
  const skipLoadThreadIdsRef = useRef(new Set<string>());
  const creatingThreadRef = useRef<Promise<string> | null>(null);

  useEffect(() => {
    let active = true;
    setListError(undefined);
    api.listThreads().then((items) => {
      if (!active) return;
      setThreads(sortThreads(items));
      setBanner((current) => (
        current === '无法连接助手，请确认 npm run dev 已启动' ? undefined : current
      ));
    }).catch(() => {
      if (!active) return;
      setListError('会话列表暂不可用');
      setBanner('无法连接助手，请确认 npm run dev 已启动');
    });
    return () => {
      active = false;
    };
  }, [api, listReloadKey]);

  useEffect(() => {
    if (!threadId) return;
    if (skipLoadThreadIdsRef.current.has(threadId)) {
      skipLoadThreadIdsRef.current.delete(threadId);
      return;
    }
    let active = true;
    api.getThread(threadId).then(() => {
      if (!active) return;
      setBanner((current) => (
        current === '无法连接助手，请确认 npm run dev 已启动' ? undefined : current
      ));
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof Error && /\b404\b/.test(error.message)) {
        navigate('/chat/new', { replace: true });
        return;
      }
      setBanner('无法连接助手，请确认 npm run dev 已启动');
    });
    return () => {
      active = false;
    };
  }, [api, navigate, threadId]);

  const ensureThread = useCallback(async (firstMessage: string) => {
    if (creatingThreadRef.current) {
      return creatingThreadRef.current;
    }
    const pending = (async () => {
      const thread = await api.createThread(firstMessage);
      skipLoadThreadIdsRef.current.add(thread.id);
      setThreads((items) => sortThreads([thread, ...items.filter((item) => item.id !== thread.id)]));
      navigate(`/chat/${thread.id}`, { replace: true });
      return thread.id;
    })();
    creatingThreadRef.current = pending;
    try {
      return await pending;
    } catch {
      setBanner('无法创建会话，请稍后重试');
      throw new Error('无法创建会话');
    } finally {
      creatingThreadRef.current = null;
    }
  }, [api, navigate]);

  function handleRetry() {
    if (banner === '无法创建会话，请稍后重试') {
      setBanner(undefined);
      return;
    }
    setListReloadKey((key) => key + 1);
  }

  return (
    <div className="chat-shell">
      <LeftPanel
        threads={threads}
        activeId={threadId}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        error={listError}
      />
      <div className="chat-main">
        {banner ? (
          <div className="chat-banner" role="status">
            <span>{banner}</span>
            <button type="button" onClick={handleRetry}>重试</button>
          </div>
        ) : null}
        <AgentChatPanel
          threadId={threadId}
          ensureThread={ensureThread}
        />
      </div>
    </div>
  );
}
