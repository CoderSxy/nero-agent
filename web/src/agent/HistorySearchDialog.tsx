import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Command } from 'cmdk';
import {
  RECENT_HISTORY_LIMIT,
  searchHistoryDocuments,
  type HistorySearchResult,
} from './history-search-index';
import type { useHistorySearch } from './use-history-search';

type SearchState = ReturnType<typeof useHistorySearch>;

function normalizeNeedle(query: string): string {
  return query.trim().normalize('NFKC').toLocaleLowerCase();
}

function highlightSnippet(text: string, query: string) {
  const needle = normalizeNeedle(query);
  if (!needle) return text;
  const haystack = text.normalize('NFKC').toLocaleLowerCase();
  const index = haystack.indexOf(needle);
  if (index < 0) return text;
  const before = text.slice(0, index);
  const match = text.slice(index, index + needle.length);
  const after = text.slice(index + needle.length);
  return <>
    {before}
    <mark className="history-search-hit">{match}</mark>
    {after}
  </>;
}

export function HistorySearchDialog({ open, search, onClose, onSelect, threadCount,
  returnFocusRef }: {
  open: boolean;
  search: SearchState;
  onClose(): void;
  onSelect(result: HistorySearchResult): void;
  threadCount: number;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const labelId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const trimmedQuery = query.trim();
  const { results, total } = useMemo(
    () => searchHistoryDocuments(search.documents, query),
    [search.documents, query],
  );
  const showLoadAll = threadCount > RECENT_HISTORY_LIMIT
    && search.scope !== 'all'
    && search.fullStatus !== 'loading'
    && search.fullStatus !== 'ready';

  useEffect(() => {
    if (!open) return;
    search.ensureRecent();
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, search]);

  useEffect(() => {
    if (open) return;
    if (search.recentStatus === 'loading') search.cancelRecent();
    setQuery('');
  }, [open, search]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, returnFocusRef]);

  if (!open) return null;

  function close() {
    onClose();
    returnFocusRef?.current?.focus();
  }

  function pick(result: HistorySearchResult) {
    onSelect(result);
    onClose();
    returnFocusRef?.current?.focus();
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  const progress = search.recentStatus === 'loading'
    ? search.recentProgress
    : search.fullStatus === 'loading'
      ? search.fullProgress
      : null;

  return createPortal(<div className="history-search-backdrop" role="presentation" onClick={close}>
    <div className="history-search-dialog" role="dialog" aria-modal="true" aria-labelledby={labelId}
      onClick={event => event.stopPropagation()}>
      <h2 id={labelId} className="history-search-title">搜索历史对话</h2>
      <Command shouldFilter={false} className="history-search-command">
        <Command.Input ref={inputRef} aria-label="搜索历史对话中的问题和回答"
          placeholder="搜索历史对话中的问题和回答"
          value={query} onValueChange={setQuery} onKeyDown={onInputKeyDown} />
        {(search.recentStatus === 'loading' || search.fullStatus === 'loading') && progress && (
          <p role="status" className="history-search-status">
            加载中 {progress.completed}/{progress.total}
          </p>
        )}
        {search.recentFailedCount > 0 && (
          <div className="history-search-banner">
            <span>最近 {search.recentFailedCount} 个会话加载失败</span>
            <button type="button" onClick={() => search.retryRecent()}>重试加载</button>
          </div>
        )}
        {search.fullFailedCount > 0 && (
          <div className="history-search-banner">
            <span>全部加载中有 {search.fullFailedCount} 个会话失败</span>
            <button type="button" onClick={() => search.retryFull()}>重试加载</button>
          </div>
        )}
        {showLoadAll && (
          <div className="history-search-load-all">
            <button type="button" onClick={() => search.loadAll()}>加载全部会话内容</button>
          </div>
        )}
        <Command.List className="history-search-list">
          {!trimmedQuery && <Command.Empty className="history-search-empty">输入关键词搜索问题和回答</Command.Empty>}
          {trimmedQuery && total === 0 && (
            <Command.Empty className="history-search-empty">没有匹配的历史对话</Command.Empty>
          )}
          {trimmedQuery && total > 0 && (
            <p className="history-search-total" aria-live="polite">共 {total} 条匹配</p>
          )}
          {trimmedQuery && results.map(result => {
            const title = result.threadTitle || '未命名会话';
            const sourceLabel = result.matchSource === 'question' ? '问题' : '回答';
            return <Command.Item key={`${result.threadId}:${result.userMessageId}`}
              className="history-search-item"
              value={`${title} ${result.matchedSnippet}`}
              onSelect={() => pick(result)}>
              <span className="history-search-item-title">{title}</span>
              <span className="history-search-item-meta">
                <span className="history-search-source">{sourceLabel}</span>
                <span className="history-search-snippet">{highlightSnippet(result.matchedSnippet, query)}</span>
              </span>
            </Command.Item>;
          })}
        </Command.List>
      </Command>
    </div>
  </div>, document.body);
}
