import { useEffect, useMemo, useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import type { CurrentUser } from '../App';
import { createHistorySearchCache } from './history-search-cache';
import type { HistorySearchResult } from './history-search-index';
import { PanelResizeHandle } from './PanelResizeHandle';
import { ThreadSidebar } from './ThreadSidebar';
import { filterThreadsBySource, type ThreadSource } from './thread-source';
import { useHistorySearch } from './use-history-search';
import { useThreadList } from './use-thread-list';
import type { Theme } from './ModelSettingsMenu';
import { neighborAfterDeletion } from './thread-scope';

function initialTheme(): Theme {
  try { return localStorage.getItem('nero-agent-theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

export type AgentShellChatActions = {
  onNew: () => void;
  canCreate: boolean;
};

export type AgentShellContextValue = {
  user: CurrentUser;
  onLogout: () => void;
  list: ReturnType<typeof useThreadList>;
  threadSource: ThreadSource;
  setThreadSource: (source: ThreadSource) => void;
  visibleThreads: ReturnType<typeof filterThreadsBySource>;
  historySearch: ReturnType<typeof useHistorySearch>;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  setChatActions: (actions: AgentShellChatActions) => void;
  deleteThread: (id: string) => Promise<void>;
};

export function AgentShell({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
  const navigate = useNavigate();
  const { threadId: routeThreadId } = useParams();
  const threadId = routeThreadId === 'new' ? undefined : routeThreadId;
  const list = useThreadList(user.id);
  const [threadSource, setThreadSource] = useState<ThreadSource>('default');
  const visibleThreads = useMemo(
    () => filterThreadsBySource(list.threads, threadSource),
    [list.threads, threadSource],
  );
  const historySearchCache = useMemo(() => createHistorySearchCache(), []);
  const historySearch = useHistorySearch({
    userId: user.id,
    threads: visibleThreads,
    cache: historySearchCache,
    scopeKey: threadSource,
  });
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [chatActions, setChatActions] = useState<AgentShellChatActions>({
    onNew: () => navigate('/agent/new'),
    canCreate: true,
  });
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [leftPreferredWidth, setLeftPreferredWidth] = useState(() => window.innerWidth <= 1050 ? 210 : 260);
  const compactPanels = viewportWidth <= 1050;
  const leftMax = Math.max(200, Math.min(420, viewportWidth - (compactPanels ? 360 : 640)));
  const leftWidth = Math.min(leftPreferredWidth, leftMax);

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    try { localStorage.setItem('nero-agent-theme', theme); } catch { /* ignore */ }
  }, [theme]);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  async function deleteThread(id: string) {
    const nextId = neighborAfterDeletion(visibleThreads, id);
    await list.deleteThread(id);
    navigate(nextId ? `/agent/${nextId}` : '/agent/new', { replace: true });
  }

  function selectHistorySearchResult(result: HistorySearchResult) {
    navigate(`/agent/${encodeURIComponent(result.threadId)}?targetMessageId=${encodeURIComponent(result.userMessageId)}`);
  }

  const outletContext: AgentShellContextValue = {
    user,
    onLogout,
    list,
    threadSource,
    setThreadSource,
    visibleThreads,
    historySearch,
    theme,
    setTheme,
    setChatActions,
    deleteThread,
  };

  return <main className="agent-layout" style={{ '--left-panel-width': `${leftWidth}px` } as React.CSSProperties}>
    <div className="left-panel-dock">
      <ThreadSidebar threads={visibleThreads} currentId={threadId} loading={list.loading} error={list.error}
        onNew={chatActions.onNew} onSelect={(id) => navigate(`/agent/${id}`)} onDelete={deleteThread}
        onRename={list.renameThread}
        theme={theme} onThemeChange={setTheme}
        canCreate={chatActions.canCreate} user={user} onLogout={onLogout}
        search={historySearch} onSearchSelect={selectHistorySearchResult}
        source={threadSource} onSourceChange={setThreadSource}
        isAdmin={user.roles.includes('admin')} />
      <PanelResizeHandle side="left" width={leftWidth} min={200} max={leftMax} onResize={setLeftPreferredWidth} />
    </div>
    <Outlet context={outletContext} />
  </main>;
}
