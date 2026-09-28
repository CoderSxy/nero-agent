import { Link } from 'react-router-dom';
import { threadSubtitle, threadTitle, type ThreadSummary } from '../lib/thread-label';

type LeftPanelProps = {
  threads: ThreadSummary[];
  activeId?: string;
  collapsed: boolean;
  onToggle(): void;
  error?: string;
};

export function LeftPanel({ threads, activeId, collapsed, onToggle, error }: LeftPanelProps) {
  return (
    <>
      <aside className={`left-panel${collapsed ? ' left-panel--collapsed' : ''}`}>
        <div className="left-panel__header">
          <Link className="new-chat-link" to="/chat/new">新对话</Link>
          <button className="panel-toggle" type="button" onClick={onToggle} aria-label="折叠会话栏">
            ‹
          </button>
        </div>
        {error ? <p className="panel-error">{error}</p> : null}
        <nav className="thread-list" aria-label="会话列表">
          {threads.map((thread) => (
            <Link
              className={`thread-link${thread.id === activeId ? ' thread-link--active' : ''}`}
              key={thread.id}
              title={threadTitle(thread)}
              to={`/chat/${thread.id}`}
            >
              <span className="thread-title">{threadTitle(thread)}</span>
              <span className="thread-subtitle">{threadSubtitle(thread)}</span>
            </Link>
          ))}
        </nav>
      </aside>
      {collapsed ? (
        <button className="panel-reopen" type="button" onClick={onToggle} aria-label="展开会话栏">
          ›
        </button>
      ) : null}
    </>
  );
}
