import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, File, FileCode2, FileImage, FileText, Folder, MoreHorizontal, RefreshCw } from 'lucide-react';
import { formatBytes, WORKSPACE_FILE_MIME } from './attachment-types';
import { deleteWorkspaceFiles, listWorkspaceFiles, type UserFileEntry, type WorkspaceUsage } from './client';
import type { WorkspaceSource } from './workspace-files';

const PROTECTED_TOP_ROOTS = new Set(['shared', 'uploads', 'projects', 'threads']);
const PROTECTED_THREAD_LEAVES = new Set(['input', 'output', 'tmp']);

export function isProtectedWorkspacePath(path: string): boolean {
  if (!path || PROTECTED_TOP_ROOTS.has(path)) return true;
  const segments = path.split('/');
  if (segments.length === 2 && segments[0] === 'threads' && segments[1]) return true;
  if (segments.length === 3 && segments[0] === 'threads' && PROTECTED_THREAD_LEAVES.has(segments[2]!)) {
    return true;
  }
  return false;
}

export function collapseSelectedPaths(paths: Iterable<string>): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  const collapsed: string[] = [];
  for (const path of sorted) {
    if (collapsed.some(parent => path === parent || path.startsWith(`${parent}/`))) continue;
    collapsed.push(path);
  }
  return collapsed;
}

function selectionSummary(selected: Set<string>, entries: UserFileEntry[]) {
  const collapsed = collapseSelectedPaths(selected);
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  let bytes = 0;
  let fileCount = 0;
  for (const path of collapsed) {
    const entry = byPath.get(path);
    if (!entry) continue;
    bytes += entry.size;
    if (entry.type === 'file') fileCount += 1;
    else {
      fileCount += entries.filter(item => item.type === 'file'
        && (item.path === path || item.path.startsWith(`${path}/`))).length;
    }
  }
  return { collapsed, itemCount: collapsed.length, fileCount, bytes };
}

export function WorkspaceFileTree({ source, workspaceId, refreshVersion, onOpenFile, onAttachFile, onFilesChanged }: {
  source: WorkspaceSource; workspaceId?: string; refreshVersion: number; onOpenFile(path: string): void;
  onAttachFile?: (path: string, source: WorkspaceSource) => void;
  onFilesChanged?: () => void;
}) {
  const [entries, setEntries] = useState<UserFileEntry[]>([]);
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualRefresh, setManualRefresh] = useState(0);
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteFeedback, setDeleteFeedback] = useState<string | null>(null);
  const canManage = source === 'personal';

  useEffect(() => {
    let active = true;
    setLoading(true);
    void listWorkspaceFiles(source, workspaceId).then(({ files, usage: nextUsage }) => {
      if (!active) return;
      setEntries(files);
      setUsage(nextUsage ?? null);
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

  useEffect(() => {
    if (!canManage) {
      setSelectionMode(false);
      setSelectedPaths(new Set());
      setPendingDelete(null);
    }
  }, [canManage]);

  const ordered = useMemo(() => [...entries].sort((a, b) => {
    const parentA = a.path.split('/').slice(0, -1).join('/');
    const parentB = b.path.split('/').slice(0, -1).join('/');
    if (parentA === parentB && a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.path.localeCompare(b.path, 'zh');
  }), [entries]);

  const summary = useMemo(() => selectionSummary(selectedPaths, entries), [selectedPaths, entries]);
  const confirmSummary = useMemo(
    () => pendingDelete ? selectionSummary(new Set(pendingDelete), entries) : null,
    [pendingDelete, entries],
  );

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
  function toggleSelected(path: string) {
    if (isProtectedWorkspacePath(path)) return;
    setSelectedPaths(previous => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }
  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedPaths(new Set());
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
  async function runDelete(paths: string[]) {
    setDeleting(true);
    setDeleteFeedback(null);
    try {
      const result = await deleteWorkspaceFiles(paths);
      const failed = result.results.filter(item => !item.ok);
      if (failed.length > 0) {
        const details = failed.map(item => `${item.path}${item.errorCode ? `（${item.errorCode}）` : ''}`).join('；');
        setDeleteFeedback(`部分删除失败：${details}。实际释放 ${formatBytes(result.freedBytes)}`);
      } else {
        setDeleteFeedback(`已释放 ${formatBytes(result.freedBytes)}`);
      }
      setUsage(result.usage);
      setPendingDelete(null);
      exitSelectionMode();
      onFilesChanged?.();
      if (!onFilesChanged) setManualRefresh(value => value + 1);
    } catch (cause) {
      setDeleteFeedback(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  return <aside className="workspace-file-panel" aria-label="文件管理">
    <div className="workspace-file-heading"><h2>文件管理</h2>
      <div className="workspace-file-heading-actions">
        {canManage && !selectionMode && <button type="button" onClick={() => {
          setSelectionMode(true);
          setDeleteFeedback(null);
        }}>批量删除</button>}
        {canManage && selectionMode && <>
          <button type="button" onClick={exitSelectionMode}>取消批量删除</button>
          <button type="button" disabled={summary.itemCount === 0 || deleting}
            onClick={() => setPendingDelete(summary.collapsed)}>删除所选</button>
        </>}
        <button type="button" title="刷新文件" aria-label="刷新文件"
          onClick={() => setManualRefresh(value => value + 1)} disabled={loading}><RefreshCw size={16} /></button>
      </div>
    </div>
    <p className="muted">{source === 'agent' ? 'Agent 工作区' : '我的工作区'}</p>
    {canManage && usage && <p className="workspace-file-usage" aria-label="工作区容量">
      已用 {formatBytes(usage.usedBytes)} / {formatBytes(usage.quotaBytes)}
      <span className="muted"> · 剩余 {formatBytes(Math.max(0, usage.quotaBytes - usage.usedBytes))}</span>
    </p>}
    {selectionMode && <p className="workspace-file-selection-summary" aria-label="已选摘要">
      已选 {summary.itemCount} 项 · {summary.fileCount} 个文件 · 预计释放 {formatBytes(summary.bytes)}
    </p>}
    {loading && <p role="status" className="muted">加载文件中…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {deleteFeedback && <p role="alert" className={deleteFeedback.includes('失败') ? 'error' : 'muted'}>{deleteFeedback}</p>}
    {!loading && !error && entries.length === 0 && <p className="muted">暂无文件</p>}
    {!error && <ul className="workspace-file-list" aria-label="工作区目录树">{ordered.filter(visible).map(entry => {
      const name = entry.path.split('/').at(-1);
      const isDirectory = entry.type === 'directory';
      const isExpanded = expanded.has(entry.path);
      const protectedPath = isProtectedWorkspacePath(entry.path);
      const showMenu = !selectionMode && !isDirectory && Boolean(onAttachFile || canManage);
      return <li key={entry.path} style={{ paddingLeft: `${(entry.path.split('/').length - 1) * 14}px` }}
        className="workspace-file-row">
        {selectionMode && <input type="checkbox" aria-label={`选择 ${entry.path}`}
          checked={selectedPaths.has(entry.path)} disabled={protectedPath}
          onChange={() => toggleSelected(entry.path)} />}
        <button type="button" title={entry.path} aria-label={isDirectory
          ? `${isExpanded ? '收起' : '展开'} ${entry.path}` : `打开 ${entry.path}`}
          aria-expanded={isDirectory ? isExpanded : undefined}
          draggable={!isDirectory && !selectionMode}
          onDragStart={event => {
            if (isDirectory || selectionMode) return;
            const payload = JSON.stringify({
              source, path: entry.path, name, size: entry.size, mimeType: guessMime(entry.path),
            });
            event.dataTransfer.setData(WORKSPACE_FILE_MIME, payload);
            event.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={() => {
            if (selectionMode) {
              if (isDirectory) toggle(entry.path);
              else toggleSelected(entry.path);
              return;
            }
            if (isDirectory) toggle(entry.path);
            else onOpenFile(entry.path);
          }}>
          {isDirectory ? <>{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Folder size={15} /></>
            : <><span className="tree-spacer" />{fileIcon(entry.path)}</>}
          <span className="workspace-file-name">{name}</span>
          {selectionMode && <span className="workspace-file-size">{formatBytes(entry.size)}</span>}
        </button>
        {showMenu && <button type="button" className="workspace-file-more"
          aria-label={`${entry.path} 的更多操作`} aria-haspopup="menu"
          aria-expanded={menuPath === entry.path}
          onClick={event => {
            event.stopPropagation();
            setMenuPath(current => current === entry.path ? null : entry.path);
          }}
          onPointerDown={event => event.stopPropagation()}>
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>}
        {showMenu && menuPath === entry.path && <div className="workspace-file-menu" role="menu"
          onPointerDown={event => event.stopPropagation()}>
          {onAttachFile && <button type="button" role="menuitem" onClick={() => {
            onAttachFile(entry.path, source);
            setMenuPath(null);
          }}>加入当前对话</button>}
          {canManage && !protectedPath && <button type="button" role="menuitem" onClick={() => {
            setMenuPath(null);
            setPendingDelete([entry.path]);
          }}>删除</button>}
        </div>}
      </li>;
    })}</ul>}
    {pendingDelete && confirmSummary && <div className="workspace-confirm-backdrop">
      <div role="dialog" aria-modal="true" aria-label="确认删除" className="workspace-delete-dialog">
        <p>将删除 {confirmSummary.itemCount} 项（约 {confirmSummary.fileCount} 个文件，预计释放 {formatBytes(confirmSummary.bytes)}）。删除后无法恢复。</p>
        <ul className="workspace-delete-paths">
          {confirmSummary.collapsed.slice(0, 8).map(path => <li key={path}>{path}</li>)}
          {confirmSummary.collapsed.length > 8 && <li>…另有 {confirmSummary.collapsed.length - 8} 项</li>}
        </ul>
        <div className="workspace-delete-actions">
          <button type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>取消</button>
          <button type="button" disabled={deleting} onClick={() => void runDelete(confirmSummary.collapsed)}>
            {deleting ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>}
  </aside>;
}
