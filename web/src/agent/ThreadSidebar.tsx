import { ThreadList, ThreadListEmpty, ThreadListItem, ThreadListItems, ThreadListNewItem } from '@mastra/playground-ui/components/ThreadList';
import type { Thread } from './thread-scope';

export function ThreadSidebar({ threads, currentId, loading, error, onNew, onSelect }: {
  threads: Thread[]; currentId?: string; loading: boolean; error: string | null;
  onNew: () => void; onSelect: (id: string) => void;
}) {
  return <aside className="agent-sidebar">
    <div className="brand">NERO <span>AGENT</span></div>
    <ThreadList aria-label="会话列表" embedded>
      <ThreadListNewItem render={<button type="button" onClick={onNew} />}>＋ 新建会话</ThreadListNewItem>
      <ThreadListItems>
        {threads.map(thread => <ThreadListItem key={thread.id} isActive={currentId === thread.id}
          onClick={() => onSelect(thread.id)}>{thread.title || '未命名会话'}</ThreadListItem>)}
      </ThreadListItems>
      {!loading && threads.length === 0 && <ThreadListEmpty>暂无会话</ThreadListEmpty>}
    </ThreadList>
    {loading && <p className="muted sidebar-note">加载会话中…</p>}
    {error && <p role="alert" className="error sidebar-note">{error}</p>}
  </aside>;
}
