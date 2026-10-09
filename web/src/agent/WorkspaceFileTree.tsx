import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, File, FileCode2, FileImage, FileText, Folder, MoreHorizontal, RefreshCw } from 'lucide-react';
import { WORKSPACE_FILE_MIME } from './attachment-types';
import { listWorkspaceFiles, type UserFileEntry } from './client';
import type { WorkspaceSource } from './workspace-files';

export function WorkspaceFileTree({ source, workspaceId, refreshVersion, onOpenFile, onAttachFile }: {
  source: WorkspaceSource; workspaceId?: string; refreshVersion: number; onOpenFile(path: string): void;
  onAttachFile?: (path: string, source: WorkspaceSource) => void;
}) {
  const [entries, setEntries] = useState<UserFileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualRefresh, setManualRefresh] = useState(0);
  const [menuPath, setMenuPath] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void listWorkspaceFiles(source, workspaceId).then(({ files }) => {
      if (!active) return;
      setEntries(files);
      setExpanded(previous => new Set([...previous].filter(path => files.some(file => file.path === path && file.type === 'directory'))));
      setError(null);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '加载文件失败');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [source, workspaceId, refreshVersion, manualRefresh]);

  useEffect(() => {
    if (!menuPath) return;
    const close = () => setMenuPath(null);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuPath]);

  const ordered = useMemo(() => [...entries].sort((a, b) => {
    const parentA = a.path.split('/').slice(0, -1).join('/');
    const parentB = b.path.split('/').slice(0, -1).join('/');
    if (parentA === parentB && a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.path.localeCompare(b.path, 'zh');
  }), [entries]);

  function visible(entry: UserFileEntry) {
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i++) if (!expanded.has(parts.slice(0, i).join('/'))) return false;
    return true;
  }
  function toggle(path: string) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }
  function fileIcon(path: string) {
    if (/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(path)) return <FileImage size={15} />;
    if (/\.(tsx?|jsx?|json|py|go|java|css|html|sh)$/i.test(path)) return <FileCode2 size={15} />;
    if (/\.(md|txt|pdf|docx?|xlsx?)$/i.test(path)) return <FileText size={15} />;
    return <File size={15} />;
  }
  function guessMime(path: string): string {
    const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
    if (extension === 'png') return 'image/png';
    if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
    if (extension === 'webp') return 'image/webp';
    if (extension === 'gif') return 'image/gif';
    if (extension === 'md' || extension === 'markdown') return 'text/markdown';
    if (extension === 'txt') return 'text/plain';
    return 'application/octet-stream';
  }
  return <aside className="workspace-file-panel" aria-label="文件管理">
    <div className="workspace-file-heading"><h2>文件管理</h2><button type="button" title="刷新文件" aria-label="刷新文件"
      onClick={() => setManualRefresh(value => value + 1)} disabled={loading}><RefreshCw size={16} /></button></div>
    <p className="muted">{source === 'agent' ? 'Agent 工作区' : '我的工作区'}</p>
    {loading && <p role="status" className="muted">加载文件中…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {!loading && !error && entries.length === 0 && <p className="muted">暂无文件</p>}
    {!error && <ul className="workspace-file-list" aria-label="工作区目录树">{ordered.filter(visible).map(entry => {
      const name = entry.path.split('/').at(-1);
      const isDirectory = entry.type === 'directory';
      const isExpanded = expanded.has(entry.path);
      return <li key={entry.path} style={{ paddingLeft: `${(entry.path.split('/').length - 1) * 14}px` }}
        className="workspace-file-row">
        <button type="button" title={entry.path} aria-label={isDirectory
          ? `${isExpanded ? '收起' : '展开'} ${entry.path}` : `打开 ${entry.path}`}
          aria-expanded={isDirectory ? isExpanded : undefined}
          draggable={!isDirectory}
          onDragStart={event => {
            if (isDirectory) return;
            const payload = JSON.stringify({
              source, path: entry.path, name, size: entry.size, mimeType: guessMime(entry.path),
            });
            event.dataTransfer.setData(WORKSPACE_FILE_MIME, payload);
            event.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={() => isDirectory ? toggle(entry.path) : onOpenFile(entry.path)}>
          {isDirectory ? <>{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Folder size={15} /></>
            : <><span className="tree-spacer" />{fileIcon(entry.path)}</>}
          <span>{name}</span>
        </button>
        {!isDirectory && onAttachFile && <button type="button" className="workspace-file-more"
          aria-label={`${entry.path} 的更多操作`} aria-haspopup="menu"
          aria-expanded={menuPath === entry.path}
          onClick={event => {
            event.stopPropagation();
            setMenuPath(current => current === entry.path ? null : entry.path);
          }}
          onPointerDown={event => event.stopPropagation()}>
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>}
        {!isDirectory && onAttachFile && menuPath === entry.path && <div className="workspace-file-menu" role="menu"
          onPointerDown={event => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => {
            onAttachFile(entry.path, source);
            setMenuPath(null);
          }}>加入当前对话</button>
        </div>}
      </li>;
    })}</ul>}
  </aside>;
}
