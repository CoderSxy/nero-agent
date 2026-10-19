import { Search, Sparkles, ChevronRight } from 'lucide-react';
import type { ThreadSource } from '../thread-source';

type HistoryThread = { id: string; title?: string | null; updatedAt?: string | Date | null };

export function MobileHistory({ threads, source, onSourceChange, onOpenThread, onSearch,
  loading, error }: {
  threads: HistoryThread[];
  source: ThreadSource;
  onSourceChange: (source: ThreadSource) => void;
  onOpenThread: (id: string) => void;
  onSearch?: () => void;
  loading: boolean;
  error: string | null;
}) {
  const scheduled = source === 'schedule';
  return <section className="mobile-history" aria-label={scheduled ? '调度对话' : '历史对话'}>
    <header className="mobile-page-heading mobile-history-heading">
      <div className="mobile-source-tabs" role="tablist" aria-label="会话列表类型">
        <button type="button" role="tab" aria-selected={!scheduled} onClick={() => onSourceChange('default')}>历史对话</button>
        <button type="button" role="tab" aria-selected={scheduled} onClick={() => onSourceChange('schedule')}>调度对话</button>
      </div>
      {onSearch && <button type="button" className="mobile-icon-button" aria-label="搜索会话" onClick={onSearch}><Search size={20} /></button>}
    </header>
    <div className="mobile-history-body">
      {loading && threads.length === 0 && <p role="status">加载会话中…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && threads.length === 0 && <p>{scheduled ? '暂无调度会话' : '暂无历史对话'}</p>}
      <ul className="mobile-history-list">{threads.map(thread => <li key={thread.id}>
        <button type="button" aria-label={`打开会话 ${thread.title || '未命名会话'}`} onClick={() => onOpenThread(thread.id)}>
          <span className="mobile-recent-mark" aria-hidden="true"><Sparkles size={15} /></span>
          <span className="mobile-recent-copy"><strong>{thread.title || '未命名会话'}</strong>
            <small>{thread.updatedAt ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(thread.updatedAt)) : ''}</small>
          </span><ChevronRight size={17} aria-hidden="true" />
        </button>
      </li>)}</ul>
    </div>
  </section>;
}
