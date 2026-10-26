import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MoreHorizontal, Search, UserRound, X } from 'lucide-react';
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
import { useMobileLayout } from './mobile/useMobileLayout';
import { MobileThreadActions } from './mobile/MobileThreadActions';
import { createThreadHistoryCache, type ThreadHistoryCache } from './thread-history-cache';

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
  threadHistoryCache: ThreadHistoryCache;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  setChatActions: (actions: AgentShellChatActions) => void;
  deleteThread: (id: string) => Promise<void>;
};

export function AgentShell({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const mobile = useMobileLayout();
  const [profileOpen, setProfileOpen] = useState(false);
  const [threadActionsOpen, setThreadActionsOpen] = useState(false);
  const { threadId: routeThreadId } = useParams();
  const threadId = routeThreadId === 'new' ? undefined : routeThreadId;
  useEffect(() => { setThreadActionsOpen(false); }, [threadId]);
  const list = useThreadList(user.id);
  const [threadSource, setThreadSource] = useState<ThreadSource>('default');
  const visibleThreads = useMemo(
    () => filterThreadsBySource(list.threads, threadSource),
    [list.threads, threadSource],
  );
  const historySearchCache = useMemo(() => createHistorySearchCache(), []);
  const threadHistoryCache = useMemo(() => createThreadHistoryCache(), []);
  useEffect(() => () => {
    threadHistoryCache.clear();
  }, [threadHistoryCache]);
  const historySearch = useHistorySearch({
    userId: user.id,
    threads: visibleThreads,
    cache: historySearchCache,
    scopeKey: threadSource,
  });
  const handleLogout = () => {
    threadHistoryCache.clear(user.id);
    onLogout();
  };
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
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!mobile || !viewport) return;
    const syncKeyboard = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty('--mobile-keyboard-inset', `${Math.ceil(inset)}px`);
    };
    syncKeyboard();
    viewport.addEventListener('resize', syncKeyboard);
    viewport.addEventListener('scroll', syncKeyboard);
    return () => {
      viewport.removeEventListener('resize', syncKeyboard);
      viewport.removeEventListener('scroll', syncKeyboard);
      document.documentElement.style.removeProperty('--mobile-keyboard-inset');
    };
  }, [mobile]);
  useEffect(() => {
    if (threadSource !== 'schedule') return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void list.refresh();
    };
    const timer = window.setInterval(refreshWhenVisible, 15_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [threadSource, list.refresh]);

  function changeThreadSource(source: ThreadSource) {
    setThreadSource(source);
    void list.refresh();
  }

  async function deleteThread(id: string) {
    const nextId = neighborAfterDeletion(visibleThreads, id);
    await list.deleteThread(id);
    threadHistoryCache.delete(user.id, id);
    navigate(nextId ? `/agent/${nextId}` : '/agent/new', { replace: true });
  }

  function selectHistorySearchResult(result: HistorySearchResult) {
    navigate(`/agent/${encodeURIComponent(result.threadId)}?targetMessageId=${encodeURIComponent(result.userMessageId)}`);
  }

  const outletContext: AgentShellContextValue = {
    user,
    onLogout: handleLogout,
    list,
    threadSource,
    setThreadSource,
    visibleThreads,
    historySearch,
    threadHistoryCache,
    theme,
    setTheme,
    setChatActions,
    deleteThread,
  };

  const inbox = location.pathname === '/agent/new';
  const returnTo = (location.state as { mobileReturnTo?: string } | null)?.mobileReturnTo === '/history'
    ? '/history' : '/agent/new';
  const activeThread = list.threads.find(thread => thread.id === threadId);
  return <main className={`agent-layout${mobile ? ' mobile-agent-layout' : ''}`} style={{ '--left-panel-width': `${leftWidth}px` } as React.CSSProperties}>
    {mobile && <>
      <header className="mobile-app-header">
        {inbox ? <button type="button" className="mobile-header-circle" aria-label="打开我的信息" onClick={() => setProfileOpen(true)}>
          {user.displayName?.charAt(0) || <UserRound size={20} />}</button>
          : <button type="button" className="mobile-header-circle" aria-label={returnTo === '/history' ? '返回历史对话' : '返回首页'}
            onClick={() => navigate(returnTo)}><ArrowLeft size={21} /></button>}
        {threadId && <strong>{activeThread?.title || '会话'}</strong>}
        {inbox && <button type="button" className="mobile-header-circle" aria-label="搜索会话" onClick={() => navigate('/history', { state: { openSearch: true } })}><Search size={20} /></button>}
        {threadId && <button type="button" className="mobile-header-circle" aria-label="更多会话操作" onClick={() => setThreadActionsOpen(true)}><MoreHorizontal size={22} /></button>}
      </header>
      {activeThread && <MobileThreadActions title={activeThread.title || '未命名会话'} open={threadActionsOpen}
        onClose={() => setThreadActionsOpen(false)} onRename={title => list.renameThread(activeThread.id, title)}
        onDelete={() => deleteThread(activeThread.id)} />}
      {profileOpen && <div className="mobile-profile-backdrop" onClick={() => setProfileOpen(false)}>
        <section className="mobile-profile-sheet" role="dialog" aria-label="我的信息" onClick={event => event.stopPropagation()}>
          <header><h2>{user.displayName}</h2><button type="button" aria-label="关闭我的信息" onClick={() => setProfileOpen(false)}><X size={20} /></button></header>
          <p>{user.email}</p>
          <div className="mobile-profile-theme" role="group" aria-label="主题"><button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>浅色</button><button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>深色</button></div>
          <button type="button" onClick={handleLogout}>退出登录</button>
        </section>
      </div>}
    </>}
    <div className="left-panel-dock">
      <ThreadSidebar threads={visibleThreads} currentId={threadId} loading={list.loading} error={list.error}
        onNew={chatActions.onNew} onSelect={(id) => navigate(`/agent/${id}`)} onDelete={deleteThread}
        onRename={list.renameThread}
        theme={theme} onThemeChange={setTheme}
        canCreate={chatActions.canCreate} user={user} onLogout={handleLogout}
        search={historySearch} onSearchSelect={selectHistorySearchResult}
        source={threadSource} onSourceChange={changeThreadSource}
        isAdmin={user.roles.includes('admin')} />
      <PanelResizeHandle side="left" width={leftWidth} min={200} max={leftMax} onResize={setLeftPreferredWidth} />
    </div>
    <Outlet context={outletContext} />
  </main>;
}
