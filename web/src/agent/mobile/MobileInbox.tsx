import type { ReactNode } from 'react';
import { Clock3, FileText, Layers3, Sparkles, ChevronRight } from 'lucide-react';
import type { ThreadSource } from '../thread-source';

type RecentThread = { id: string; title?: string | null; updatedAt?: string | Date | null };

function recentTime(value: RecentThread['updatedAt']): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

export function MobileInbox({ threads, source, onSourceChange, onNavigate, onOpenThread,
  loading, error, modelCount, composer }: {
  threads: RecentThread[];
  source: ThreadSource;
  onSourceChange: (source: ThreadSource) => void;
  onNavigate: (path: string) => void;
  onOpenThread: (id: string) => void;
  loading: boolean;
  error: string | null;
  modelCount?: number;
  composer: ReactNode;
}) {
  const scheduled = source === 'schedule';
  return <section className="mobile-inbox" aria-label="Inbox">
    <h1>NERO</h1>
    <div className="mobile-inbox-cards" aria-label="概览">
      <button type="button" className="mobile-overview-card" aria-label={`${scheduled ? '调度对话' : '历史对话'}，${threads.length} 个会话`}
        onClick={() => onNavigate('/history')}>
        <Clock3 className="mobile-card-icon warm" size={24} aria-hidden="true" />
        <span>{scheduled ? '调度对话' : '历史对话'} <b>{threads.length}</b></span>
      </button>
      <button type="button" className="mobile-overview-card" aria-label="文件管理" onClick={() => onNavigate('/files')}>
        <FileText className="mobile-card-icon blue" size={24} aria-hidden="true" /><span>文件管理</span>
      </button>
      <button type="button" className="mobile-overview-card" aria-label="模型列表" onClick={() => onNavigate('/models')}>
        <Layers3 className="mobile-card-icon rose" size={24} aria-hidden="true" />
        <span>模型列表 {modelCount === undefined ? null : <b>{modelCount}</b>}</span>
      </button>
      <button type="button" className="mobile-overview-card is-placeholder" aria-label="敬请期待" disabled>
        <Sparkles className="mobile-card-icon amber" size={24} aria-hidden="true" /><span>敬请期待</span>
      </button>
    </div>
    <section className="mobile-inbox-recent" aria-label={scheduled ? '最近调度' : '最近会话'}>
      <div className="mobile-recent-heading">
        <div className="mobile-source-tabs" role="tablist" aria-label="最近列表类型">
          <button role="tab" aria-selected={!scheduled} type="button" onClick={() => onSourceChange('default')}>最近会话</button>
          <button role="tab" aria-selected={scheduled} type="button" onClick={() => onSourceChange('schedule')}>最近调度</button>
        </div>
        <button type="button" className="mobile-text-link" onClick={() => onNavigate('/scheduled-tasks')}>定时任务 <span aria-hidden="true">→</span></button>
      </div>
      {loading && threads.length === 0 ? <p role="status">加载会话中…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!loading && !error && threads.length === 0 ? <p>{scheduled ? '暂无调度会话。' : '暂无会话，点下方输入框开始。'}</p> : null}
      <ul className="mobile-recent-list">
        {threads.slice(0, 5).map(thread => <li key={thread.id}>
          <button type="button" aria-label={`打开会话 ${thread.title || '未命名会话'}`} onClick={() => onOpenThread(thread.id)}>
            <span className="mobile-recent-mark" aria-hidden="true"><Sparkles size={15} /></span>
            <span className="mobile-recent-copy"><strong>{thread.title || '未命名会话'}</strong><small>{recentTime(thread.updatedAt)}</small></span>
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </li>)}
      </ul>
    </section>
    <div className="mobile-inbox-composer">{composer}</div>
  </section>;
}
