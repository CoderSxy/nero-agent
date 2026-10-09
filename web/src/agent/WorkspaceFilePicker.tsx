import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, File, Folder, X } from 'lucide-react';
import { listWorkspaceFiles, type UserFileEntry } from './client';
import type { WorkspaceSource } from './workspace-files';

export function WorkspaceFilePicker({ source, onConfirm, onClose }: {
  source: WorkspaceSource;
  onConfirm: (paths: string[]) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<UserFileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void listWorkspaceFiles(source).then(({ files }) => {
      if (!active) return;
      setEntries(files);
      setError(null);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '加载文件失败');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [source]);

  const ordered = useMemo(() => [...entries].sort((a, b) => {
    const parentA = a.path.split('/').slice(0, -1).join('/');
    const parentB = b.path.split('/').slice(0, -1).join('/');
    if (parentA === parentB && a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.path.localeCompare(b.path, 'zh');
  }), [entries]);

  const needle = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => {
    if (!needle) return ordered;
    return ordered.filter(entry => entry.path.toLocaleLowerCase().includes(needle)
      || (entry.path.split('/').at(-1) ?? '').toLocaleLowerCase().includes(needle));
  }, [ordered, needle]);

  function visible(entry: UserFileEntry) {
    if (needle) {
      if (entry.type === 'directory') {
        return filtered.some(item => item.type === 'file' && (item.path === entry.path
          || item.path.startsWith(`${entry.path}/`)));
      }
      return true;
    }
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i++) if (!expanded.has(parts.slice(0, i).join('/'))) return false;
    return true;
  }

  function toggleExpand(path: string) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  function toggleSelect(path: string) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  function confirm() {
    onConfirm([...selected]);
    onClose();
  }

  return <div className="workspace-file-picker-backdrop" role="presentation" onClick={onClose}>
    <div className="workspace-file-picker" role="dialog" aria-label="选择工作区文件"
      onClick={event => event.stopPropagation()}>
      <div className="workspace-file-picker-header">
        <strong>选择工作区文件</strong>
        <button type="button" aria-label="关闭" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="workspace-file-picker-search">
        <input type="search" aria-label="搜索文件" placeholder="搜索路径或文件名"
          value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <div className="workspace-file-picker-body">
        {loading && <p role="status" className="muted">加载文件中…</p>}
        {error && <p role="alert" className="error">{error}</p>}
        {!loading && !error && filtered.length === 0 && <p className="muted">暂无文件</p>}
        {!error && <ul className="workspace-file-picker-list" aria-label="可选文件">
          {filtered.filter(visible).map(entry => {
            const name = entry.path.split('/').at(-1) ?? entry.path;
            const isDirectory = entry.type === 'directory';
            const isExpanded = expanded.has(entry.path) || Boolean(needle);
            const depth = entry.path.split('/').length - 1;
            return <li key={entry.path} style={{ paddingLeft: `${depth * 14}px` }}>
              {isDirectory ? <button type="button" aria-label={`${isExpanded ? '收起' : '展开'} ${entry.path}`}
                aria-expanded={isExpanded} onClick={() => toggleExpand(entry.path)}>
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Folder size={15} /><span>{name}</span>
              </button> : <label className="workspace-file-picker-file">
                <input type="checkbox" aria-label={`选择 ${entry.path}`}
                  checked={selected.has(entry.path)}
                  onChange={() => toggleSelect(entry.path)} />
                <File size={15} /><span title={entry.path}>{needle ? entry.path : name}</span>
              </label>}
            </li>;
          })}
        </ul>}
      </div>
      <div className="workspace-file-picker-footer">
        <button type="button" onClick={onClose}>取消</button>
        <button type="button" className="workspace-file-picker-confirm" onClick={confirm}
          disabled={selected.size === 0}>确认</button>
      </div>
    </div>
  </div>;
}
