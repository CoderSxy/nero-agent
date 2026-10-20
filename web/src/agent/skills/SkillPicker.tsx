import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { Check, RefreshCw, Search, X } from 'lucide-react';
import { listAvailableSkills } from './skills-api';
import { SELECTED_SKILL_IDS_MAX, limitSkillIds } from './selection';
import { toSkillUiState } from './skill-ui-state';
import type { SkillSummary } from './types';

export type SkillPickerHandle = {
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => boolean;
};

export type SkillPickerProps = {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  scopeKey?: string;
  preserveMissing?: boolean;
  open: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onRequestClose: () => void;
  onPicked: (id: string) => void;
  onCatalogChange: (items: SkillSummary[]) => void;
  onPhaseChange: (phase: 'loading' | 'ready' | 'error') => void;
  inputMode: 'slash' | 'search';
};

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function normalizeQuery(query: string | undefined): string {
  return (query ?? '').replace(/^\//, '').trim();
}

export const SkillPicker = forwardRef<SkillPickerHandle, SkillPickerProps>(function SkillPicker({
  value, onChange, disabled = false, scopeKey = '', preserveMissing = false, open, query, onQueryChange,
  onRequestClose, onPicked, onCatalogChange, onPhaseChange, inputMode,
}, ref) {
  const [items, setItems] = useState<SkillSummary[]>([]);
  const [search, setSearch] = useState<{ query: string; scope: string; status: 'ready' | 'error'; items: SkillSummary[]; error?: unknown } | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const requestId = useRef(0);
  const searchId = useRef(0);
  const onChangeRef = useRef(onChange);
  const onCatalogChangeRef = useRef(onCatalogChange);
  const onPhaseChangeRef = useRef(onPhaseChange);
  const onRequestCloseRef = useRef(onRequestClose);
  const onPickedRef = useRef(onPicked);
  onChangeRef.current = onChange;
  onCatalogChangeRef.current = onCatalogChange;
  onPhaseChangeRef.current = onPhaseChange;
  onRequestCloseRef.current = onRequestClose;
  onPickedRef.current = onPicked;

  const normalized = normalizeQuery(query);
  const searching = open && !!normalized;
  const currentSearch = searching && search?.query === normalized && search.scope === scopeKey ? search : null;
  const searchPending = searching && !currentSearch;
  const ready = phase !== 'error' && (searching ? currentSearch?.status === 'ready' : phase === 'ready');
  const visibleItems = searching ? (currentSearch?.status === 'ready' ? currentSearch.items : []) : items;
  const rowDisabled = (item: SkillSummary) => disabled
    || !ready
    || value.includes(item.id)
    || value.length >= SELECTED_SKILL_IDS_MAX;
  const enabledIndexes = visibleItems.flatMap((item, index) => rowDisabled(item) ? [] : [index]);
  const activeIndex = enabledIndexes.includes(highlight) ? highlight : (enabledIndexes[0] ?? -1);

  useEffect(() => {
    const id = ++requestId.current;
    searchId.current += 1;
    const controller = new AbortController();
    setPhase('loading');
    setError(null);
    setItems([]);
    setSearch(null);
    onPhaseChangeRef.current('loading');
    void (async () => {
      const all = new Map<string, SkillSummary>();
      for (let pageNumber = 1; ; pageNumber += 1) {
        const page = await listAvailableSkills({ page: pageNumber, pageSize: 50 }, controller.signal);
        if (id !== requestId.current || controller.signal.aborted) return;
        for (const item of page.items) all.set(item.id, item);
        if (page.items.length < page.pageSize || pageNumber * page.pageSize >= page.total) break;
      }
      if (id !== requestId.current || controller.signal.aborted) return;
      const next = [...all.values()].filter(item => item.userInvocable !== false);
      setItems(next);
      setPhase('ready');
      onPhaseChangeRef.current('ready');
      onCatalogChangeRef.current(next);
    })().catch(cause => {
      if (id !== requestId.current || controller.signal.aborted) return;
      setPhase('error');
      setError(cause);
      onPhaseChangeRef.current('error');
    });
    return () => controller.abort();
  }, [scopeKey, refreshNonce]);

  useEffect(() => {
    const id = ++searchId.current;
    if (!open || !normalized) {
      setSearch(null);
      return;
    }
    const controller = new AbortController();
    void listAvailableSkills({ page: 1, pageSize: 50, q: normalized }, controller.signal)
      .then(page => {
        if (id !== searchId.current || controller.signal.aborted) return;
        setSearch({ query: normalized, scope: scopeKey, status: 'ready', items: page.items.filter(item => item.userInvocable !== false) });
      })
      .catch(cause => {
        if (id !== searchId.current || controller.signal.aborted) return;
        setSearch({ query: normalized, scope: scopeKey, status: 'error', items: [], error: cause });
      });
    return () => controller.abort();
  }, [normalized, scopeKey, refreshNonce, open]);

  useEffect(() => {
    if (phase !== 'ready' || preserveMissing) return;
    const allowed = new Set(items.map(item => item.id));
    const next = value.filter(id => allowed.has(id));
    if (!sameIds(next, value)) onChangeRef.current(next);
  }, [phase, items, value, preserveMissing]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = document.getElementById(`skill-option-${visibleItems[activeIndex]?.id}`);
    if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, visibleItems]);

  function choose(id: string) {
    if (rowDisabled(visibleItems.find(item => item.id === id) ?? { id } as SkillSummary)) return;
    onChange(limitSkillIds([...value, id]));
    onPickedRef.current(id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): boolean {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
      if (event.key === 'Tab') {
        onRequestCloseRef.current();
        return false;
      }
      if (!open) return false;
      if (event.key === 'Enter' && event.shiftKey) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        onRequestCloseRef.current();
        return true;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (enabledIndexes.length === 0) return true;
        const position = Math.max(0, enabledIndexes.indexOf(activeIndex));
        const next = event.key === 'ArrowDown'
          ? enabledIndexes[(position + 1) % enabledIndexes.length]!
          : enabledIndexes[(position - 1 + enabledIndexes.length) % enabledIndexes.length]!;
        setHighlight(next);
        return true;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = activeIndex >= 0 ? visibleItems[activeIndex] : undefined;
        if (item && !rowDisabled(item)) choose(item.id);
        return true;
      }
      return false;
  }
  useImperativeHandle(ref, () => ({ handleKeyDown }));

  if (!open) return null;
  const uiError = phase === 'error' ? toSkillUiState(error)
    : currentSearch?.status === 'error' ? toSkillUiState(currentSearch.error) : null;
  const selected = new Set(value);
  return <div className="skill-picker-panel" onMouseDown={event => {
    if ((event.target as HTMLElement).closest('input')) return;
    event.preventDefault();
  }}>
    <div className="skill-picker-panel-header">
      <div className="skill-picker-title">
        <span className="skill-picker-mark" aria-hidden="true">/</span>
        <strong>选择技能</strong>
      </div>
      <div className="skill-picker-header-actions">
        <button type="button" aria-label="刷新技能权限" title="刷新" disabled={disabled}
          onClick={() => setRefreshNonce(nonce => nonce + 1)}><RefreshCw size={14} aria-hidden="true" /></button>
        <button type="button" aria-label="关闭技能选择" title="关闭" onClick={onRequestClose}>
          <X size={15} aria-hidden="true" /></button>
      </div>
    </div>
    {inputMode === 'search' && <label className="skill-picker-search">
      <Search size={15} aria-hidden="true" />
      <input type="search" autoFocus onKeyDown={handleKeyDown} aria-label="搜索技能" placeholder="搜索技能名称或描述"
        value={query} disabled={disabled} onChange={event => onQueryChange(event.target.value)} />
    </label>}
    <div className="skill-picker-body">
      {searchPending && phase !== 'error' ? <p className="skill-picker-status" role="status">正在搜索技能…</p> : null}
      {!searching && phase === 'loading' && <p className="skill-picker-status" role="status">正在加载技能…</p>}
      {uiError && <p className="skill-picker-status is-error" role="alert">{uiError.message}
        {uiError.retryable && <button type="button" onClick={() => setRefreshNonce(nonce => nonce + 1)}>重试</button>}
      </p>}
      {phase === 'ready' && visibleItems.length === 0 && !normalized && <div className="skill-picker-empty">
        <p>暂无可用技能</p>
        <span>到技能管理里启用后，就能在这里选用</span>
      </div>}
      {ready && visibleItems.length === 0 && !!normalized && <div className="skill-picker-empty">
        <p>未找到匹配技能</p>
        <span>换个名称，或清空输入查看全部</span>
      </div>}
      {ready && visibleItems.length > 0 && <div role="listbox" aria-label="可选技能">
        {visibleItems.map((item, index) => {
          const picked = selected.has(item.id);
          return <button type="button" role="option" id={`skill-option-${item.id}`}
            key={item.id} aria-label={item.name} aria-selected={picked}
            data-highlighted={index === activeIndex ? 'true' : 'false'}
            disabled={rowDisabled(item)} onMouseEnter={() => { if (!rowDisabled(item)) setHighlight(index); }}
            onClick={() => choose(item.id)}>
            <span className="skill-picker-option-mark" aria-hidden="true">/</span>
            <span className="skill-picker-option-copy">
              <span>{item.name}</span>
              {item.description && <small>{item.description}</small>}
            </span>
            {picked && <Check className="skill-picker-option-check" size={15} aria-hidden="true" />}
          </button>;
        })}
      </div>}
      {value.length >= SELECTED_SKILL_IDS_MAX && <p className="skill-picker-limit" role="status">最多选择 5 个技能</p>}
    </div>
    <p className="skill-picker-hint"><kbd>↑</kbd><kbd>↓</kbd><span>切换</span><kbd>Enter</kbd><span>选择</span><kbd>Esc</kbd><span>关闭</span></p>
  </div>;
});
