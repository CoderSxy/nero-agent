import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, List, MoreVertical, Search } from 'lucide-react';
import { HistorySearchDialog } from './HistorySearchDialog';
import type { HistorySearchResult } from './history-search-index';
import type { useHistorySearch } from './use-history-search';
import { ThreadList, ThreadListEmpty, ThreadListItems, ThreadListNewItem } from '@mastra/playground-ui/components/ThreadList';
import type { Thread } from './thread-scope';
import { ModelSettingsMenu, type Theme } from './ModelSettingsMenu';
import { formatThreadTime, groupThreadsByTime } from './thread-history';
import type { CurrentUser } from '../App';
import type { ThreadSource } from './thread-source';

export function ThreadSidebar({ threads, currentId, loading, error, onNew, onSelect,
  onDelete, onRename, theme, onThemeChange,
  canCreate = true, user, onLogout, search, onSearchSelect,
  source = 'default', onSourceChange }: {
  threads: Thread[]; currentId?: string; loading: boolean; error: string | null;
  onNew: () => void; onSelect: (id: string) => void;
  onDelete?: (id: string) => Promise<void>;
  onRename?: (id: string, title: string) => Promise<void>;
  theme: Theme; onThemeChange: (theme: Theme) => void;
  canCreate?: boolean;
  user?: CurrentUser; onLogout?: () => void;
  search?: ReturnType<typeof useHistorySearch>;
  onSearchSelect?: (result: HistorySearchResult) => void;
  source?: ThreadSource;
  onSourceChange?: (source: ThreadSource) => void;
}) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyMode, setHistoryMode] = useState<'grouped' | 'flat'>('grouped');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchLauncherRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const searchEnabled = Boolean(search && onSearchSelect);
  useEffect(() => { if (confirmId) cancelRef.current?.focus(); }, [confirmId]);
  useEffect(() => {
    if (!searchEnabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'k' || (!event.metaKey && !event.ctrlKey) || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.isContentEditable) return;
      if (target instanceof HTMLElement && target.closest('.history-search-dialog')) {
        event.preventDefault();
        setSearchOpen(open => !open);
        return;
      }
      event.preventDefault();
      setSearchOpen(open => !open);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [searchEnabled]);
  useEffect(() => {
    if (!menuId && !confirmId && !renameId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleting && !saving) {
        setMenuId(null); setConfirmId(null); setRenameId(null); setDeleteError(null); setRenameError(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuId, confirmId, renameId, deleting, saving]);
  useEffect(() => {
    if (!menuId) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest('.thread-menu, .thread-more')) setMenuId(null);
    };
    const closeOnResize = () => setMenuId(null);
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', closeOnResize);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [menuId]);
  const confirmingThread = threads.find(thread => thread.id === confirmId);
  const menuThread = threads.find(thread => thread.id === menuId);
  async function saveRename() {
    if (!renameId || !onRename || saving) return;
    const title = renameDraft.trim();
    if (!title) { setRenameError('会话名称不能为空'); return; }
    setSaving(true); setRenameError(null);
    try { await onRename(renameId, title); setRenameId(null); }
    catch (cause) { setRenameError(cause instanceof Error ? cause.message : '修改会话名失败'); }
    finally { setSaving(false); }
  }
  async function confirmDelete() {
    if (!confirmId || !onDelete || deleting) return;
    setDeleting(true); setDeleteError(null);
    try { await onDelete(confirmId); setConfirmId(null); setMenuId(null); }
    catch (cause) { setDeleteError(cause instanceof Error ? cause.message : '删除会话失败'); }
    finally { setDeleting(false); }
  }
  const now = new Date();
  const renderThread = (thread: Thread, showTime: boolean) => <li key={thread.id} className="thread-row group relative">
    <button type="button" className="thread-select inline-flex h-control-md w-full min-w-0 cursor-pointer items-center justify-start rounded-xl border border-transparent bg-transparent px-3 text-left text-label text-muted-foreground hover:text-foreground"
      aria-current={currentId === thread.id ? 'page' : undefined}
      onClick={() => { setMenuId(null); onSelect(thread.id); }}>
      <span>{thread.title || '未命名会话'}</span>
      {showTime && <small className="thread-time">{formatThreadTime(thread.updatedAt || thread.createdAt, now)}</small>}
    </button>
    <button type="button" className="thread-more absolute top-1/2 right-1 flex h-control-sm w-control-sm -translate-y-1/2 items-center justify-center rounded-full border border-transparent bg-transparent text-muted-foreground hover:bg-fill-subtle hover:text-foreground"
      aria-label={`${thread.title || '未命名会话'} 的更多操作`}
      aria-expanded={menuId === thread.id} aria-haspopup="menu"
      onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMenuPosition({
          top: window.innerHeight - rect.bottom < 96 ? Math.max(4, rect.top - 88) : rect.bottom + 4,
          left: Math.max(4, rect.right - 140),
        });
        setMenuId(value => value === thread.id ? null : thread.id);
      }}>
      <MoreVertical size={17} aria-hidden="true" />
    </button>
  </li>;
  return <aside className="agent-sidebar">
    <div className="brand" aria-label="NERO AGENT">
      <span className="brand-mark" aria-hidden="true">N</span>
      <span className="brand-name">NERO</span>
      <span className="brand-tag">AGENT</span>
    </div>
    <div className="thread-scroll">
    <ThreadList aria-label="会话列表" embedded>
      <ThreadListNewItem render={<button type="button" className="new-thread-button" onClick={onNew}
        disabled={!canCreate} />}>新建会话</ThreadListNewItem>
      {onSourceChange && <div className="thread-source-tabs" role="tablist" aria-label="会话来源">
        <button type="button" role="tab" aria-selected={source === 'default'}
          className={source === 'default' ? 'active' : undefined}
          onClick={() => onSourceChange('default')}>历史</button>
        <button type="button" role="tab" aria-selected={source === 'schedule'}
          className={source === 'schedule' ? 'active' : undefined}
          onClick={() => onSourceChange('schedule')}>调度</button>
      </div>}
      <div className="thread-history-heading">
        <span>{source === 'schedule' ? '调度会话' : '历史对话'}</span>
        <div className="thread-history-actions">
          {searchEnabled && <button ref={searchLauncherRef} type="button" className="thread-history-toggle"
            aria-label={source === 'schedule' ? '搜索调度会话' : '搜索历史对话'}
            title={source === 'schedule' ? '搜索调度会话' : '搜索历史对话'}
            onClick={() => setSearchOpen(true)}>
            <Search size={16} aria-hidden="true" />
          </button>}
          <button type="button" className="thread-history-toggle"
            aria-label={historyMode === 'grouped' ? '切换为普通列表' : '切换为时间分组'}
            title={historyMode === 'grouped' ? '切换为普通列表' : '切换为时间分组'}
            onClick={() => setHistoryMode(mode => mode === 'grouped' ? 'flat' : 'grouped')}>
            {historyMode === 'grouped' ? <List size={16} aria-hidden="true" /> : <CalendarDays size={16} aria-hidden="true" />}
          </button>
        </div>
      </div>
      <div className="thread-list-scroll" onScroll={() => setMenuId(null)}>
        <ThreadListItems>
          {historyMode === 'flat' ? threads.map(thread => renderThread(thread, true))
            : groupThreadsByTime(threads, now).map(group => <Fragment key={group.key}>
              <li className="thread-group-heading">{group.label}</li>
              {group.items.map(thread => renderThread(thread, false))}
            </Fragment>)}
        </ThreadListItems>
        {!loading && threads.length === 0 && <ThreadListEmpty>
          {source === 'schedule' ? '暂无调度会话' : '暂无会话'}
        </ThreadListEmpty>}
        {loading && <p className="muted sidebar-note">加载会话中…</p>}
        {error && <p role="alert" className="error sidebar-note">{error}</p>}
      </div>
    </ThreadList>
    </div>
    {menuThread && createPortal(<div className="thread-menu" role="menu"
      aria-label={`${menuThread.title || '未命名会话'} 操作`} style={menuPosition}>
      {onRename && <button type="button" role="menuitem" onClick={() => {
        setMenuId(null); setRenameError(null); setRenameDraft(menuThread.title || ''); setRenameId(menuThread.id);
      }}>修改会话名</button>}
      <button type="button" role="menuitem" onClick={() => {
        setMenuId(null); setDeleteError(null); setConfirmId(menuThread.id);
      }} className="danger">删除会话</button>
    </div>, document.body)}
    {renameId && <div className="thread-confirm-backdrop">
      <form className="thread-confirm" role="dialog" aria-modal="true" aria-label="修改会话名"
        onSubmit={event => { event.preventDefault(); void saveRename(); }}>
        <h2>修改会话名</h2>
        <label htmlFor="thread-rename-input">会话名称</label>
        <input id="thread-rename-input" autoFocus maxLength={100} value={renameDraft}
          onChange={event => setRenameDraft(event.target.value)} />
        {renameError && <p role="alert" className="error">{renameError}</p>}
        <div className="thread-confirm-actions">
          <button type="button" disabled={saving} onClick={() => setRenameId(null)}>取消</button>
          <button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </div>}
    {confirmId && <div className="thread-confirm-backdrop">
      <div className="thread-confirm" role="alertdialog" aria-modal="true" aria-label="删除会话">
        <h2>删除会话</h2>
        <p>确定删除「{confirmingThread?.title || '未命名会话'}」？删除后无法恢复。</p>
        {deleteError && <p role="alert" className="error">{deleteError}</p>}
        <div className="thread-confirm-actions">
          <button ref={cancelRef} type="button" disabled={deleting} onClick={() => setConfirmId(null)}>取消</button>
          <button type="button" className="danger" disabled={deleting} onClick={() => void confirmDelete()}>
            {deleting ? '删除中…' : '确认删除'}</button>
        </div>
      </div>
    </div>}
    {searchEnabled && search && onSearchSelect && <HistorySearchDialog open={searchOpen} search={search}
      threadCount={threads.length} returnFocusRef={searchLauncherRef}
      onClose={() => setSearchOpen(false)} onSelect={onSearchSelect} />}
    <ModelSettingsMenu theme={theme} onThemeChange={onThemeChange} user={user} onLogout={onLogout} />
  </aside>;
}
