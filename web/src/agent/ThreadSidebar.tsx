import { ThreadList, ThreadListEmpty, ThreadListItem, ThreadListItems, ThreadListNewItem } from '@mastra/playground-ui/components/ThreadList';
import type { Thread } from './thread-scope';
import type { SafeModel } from './model-catalog-client';
import type { ModelSettings } from './model-settings';
import { ModelSettingsMenu, type Theme } from './ModelSettingsMenu';
import type { CurrentUser } from '../App';

export function ThreadSidebar({ threads, currentId, loading, error, onNew, onSelect,
  models, catalog, theme, onModelsChange, onThemeChange, settingsError, settingsSaving, canCreate = true,
  user, onLogout }: {
  threads: Thread[]; currentId?: string; loading: boolean; error: string | null;
  onNew: () => void; onSelect: (id: string) => void;
  models: Partial<ModelSettings>; catalog: SafeModel[]; theme: Theme;
  onModelsChange: (models: ModelSettings) => void; onThemeChange: (theme: Theme) => void;
  settingsError?: string | null; settingsSaving?: boolean;
  canCreate?: boolean;
  user?: CurrentUser; onLogout?: () => void;
}) {
  return <aside className="agent-sidebar">
    <div className="brand">NERO <span>AGENT</span></div>
    <div className="thread-scroll">
    <ThreadList aria-label="会话列表" embedded>
      <ThreadListNewItem render={<button type="button" onClick={onNew} disabled={!canCreate} />}>＋ 新建会话</ThreadListNewItem>
      <ThreadListItems>
        {threads.map(thread => <ThreadListItem key={thread.id} isActive={currentId === thread.id}
          onClick={() => onSelect(thread.id)}>{thread.title || '未命名会话'}</ThreadListItem>)}
      </ThreadListItems>
      {!loading && threads.length === 0 && <ThreadListEmpty>暂无会话</ThreadListEmpty>}
    </ThreadList>
    {loading && <p className="muted sidebar-note">加载会话中…</p>}
    {error && <p role="alert" className="error sidebar-note">{error}</p>}
    </div>
    <ModelSettingsMenu models={models} catalog={catalog} theme={theme}
      onModelsChange={onModelsChange} onThemeChange={onThemeChange}
      error={settingsError} disabled={settingsSaving} />
    {user && <div className="account-footer"><span title={user.email}>{user.displayName}</span>
      <button type="button" onClick={onLogout}>退出登录</button></div>}
  </aside>;
}
