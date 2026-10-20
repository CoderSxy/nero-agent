import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { listAvailableSkills } from './skills-api';
import { SELECTED_SKILL_IDS_MAX, limitSkillIds } from './selection';
import type { SkillSummary } from './types';

export type SkillPickerProps = {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  /** Changes when the conversation changes so a late catalog response cannot land on the new thread. */
  scopeKey?: string;
  /** Text after a leading `/` in the composer. `undefined` means slash search is closed. */
  slashQuery?: string;
  /** After a failed send, revoked ids stay visible as 失效 instead of being dropped or replaced. */
  preserveMissing?: boolean;
  onPickedFromSlash?: () => void;
};

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function SkillPicker({ value, onChange, disabled = false, scopeKey = '', slashQuery,
  preserveMissing = false, onPickedFromSlash }: SkillPickerProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SkillSummary[]>([]);
  const [searchItems, setSearchItems] = useState<SkillSummary[] | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [localQuery, setLocalQuery] = useState('');
  const requestId = useRef(0);
  const searchId = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const scopeRef = useRef(scopeKey);
  const query = (slashQuery ?? localQuery).replace(/^\//, '').trim();
  const visibleItems = searchItems ?? items;

  useEffect(() => {
    if (slashQuery !== undefined) setOpen(true);
  }, [slashQuery]);

  useEffect(() => {
    const id = ++requestId.current;
    const controller = new AbortController();
    const scopeChanged = scopeRef.current !== scopeKey;
    scopeRef.current = scopeKey;
    if (scopeChanged) {
      setItems([]);
      setSearchItems(null);
    }
    setPhase('loading');
    setError(null);
    // Only a complete successful catalog can establish that a selected ID was
    // revoked. A search page / the first 50 results is never an authorization list.
    void (async () => {
      const all = new Map<string, SkillSummary>();
      for (let pageNumber = 1; ; pageNumber += 1) {
        const page = await listAvailableSkills({ page: pageNumber, pageSize: 50 }, controller.signal);
        if (id !== requestId.current || controller.signal.aborted) return;
        for (const item of page.items) all.set(item.id, item);
        if (page.items.length < page.pageSize || pageNumber * page.pageSize >= page.total) break;
      }
      if (id !== requestId.current || controller.signal.aborted) return;
      setItems([...all.values()].filter(item => item.userInvocable !== false));
      setPhase('ready');
    })()
      .catch(cause => {
        if (id !== requestId.current || controller.signal.aborted) return;
        setPhase('error');
        setError(cause instanceof Error ? cause.message : '技能目录加载失败');
      });
    return () => controller.abort();
  }, [scopeKey, refreshNonce]);

  useEffect(() => {
    if (!query) {
      setSearchItems(null);
      return;
    }
    const id = ++searchId.current;
    const controller = new AbortController();
    void listAvailableSkills({ page: 1, pageSize: 50, q: query }, controller.signal)
      .then(page => {
        if (id !== searchId.current) return;
        setSearchItems(page.items.filter(item => item.userInvocable !== false));
      })
      .catch(() => {
        if (id !== searchId.current || controller.signal.aborted) return;
      });
    return () => controller.abort();
  }, [query, scopeKey, refreshNonce]);

  useEffect(() => {
    if (phase !== 'ready' || preserveMissing) return;
    const allowed = new Set(items.map(item => item.id));
    const next = value.filter(id => allowed.has(id));
    if (!sameIds(next, value)) onChangeRef.current(next);
  }, [phase, items, value, preserveMissing]);

  function choose(id: string) {
    if (disabled || value.includes(id) || value.length >= SELECTED_SKILL_IDS_MAX) return;
    onChange(limitSkillIds([...value, id]));
    if (slashQuery !== undefined) onPickedFromSlash?.();
    setOpen(false);
    setLocalQuery('');
  }

  const byId = new Map(items.map(item => [item.id, item]));

  return <div className="skill-picker">
    {value.length > 0 && <div className="skill-picker-chips" aria-label="已选技能">
      {value.map(id => {
        const skill = byId.get(id);
        const invalid = phase === 'ready' && !skill;
        const label = invalid ? '失效' : (skill?.name ?? id);
        return <span key={id} className={`skill-chip${invalid ? ' is-invalid' : ''}`} data-skill-id={id}>
          {label}
          <button type="button" aria-label={`移除技能 ${invalid ? id : label}`} disabled={disabled}
            onClick={() => onChange(value.filter(item => item !== id))}>
            <X size={12} aria-hidden="true" />
          </button>
        </span>;
      })}
    </div>}
    <div className="skill-picker-toolbar">
      <button type="button" aria-label="选择技能" aria-expanded={open} aria-haspopup="listbox"
        disabled={disabled} onClick={() => setOpen(current => !current)}>选择技能</button>
      <button type="button" aria-label="刷新技能权限" disabled={disabled}
        onClick={() => setRefreshNonce(nonce => nonce + 1)}>刷新</button>
      {value.length >= SELECTED_SKILL_IDS_MAX && <span role="status">最多选择 5 个技能</span>}
    </div>
    {open && <div className="skill-picker-menu">
      <input type="search" aria-label="搜索技能" placeholder="输入 / 搜索技能" value={slashQuery ?? localQuery}
        disabled={disabled} onChange={event => setLocalQuery(event.target.value)} />
      {phase === 'loading' && <p role="status">正在加载技能…</p>}
      {phase === 'error' && <p role="alert">{error}
        <button type="button" onClick={() => setRefreshNonce(nonce => nonce + 1)}>重试</button>
      </p>}
      {phase === 'ready' && <div role="listbox" aria-label="可选技能">
        {visibleItems.length === 0 && <p>没有可选择的技能</p>}
        {visibleItems.map(item => <button type="button" key={item.id} role="option"
          aria-selected={value.includes(item.id)} disabled={disabled || (!value.includes(item.id) && value.length >= SELECTED_SKILL_IDS_MAX)}
          onClick={() => choose(item.id)}>
          {item.name}
        </button>)}
      </div>}
    </div>}
  </div>;
}
