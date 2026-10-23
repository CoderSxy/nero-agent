import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, File, FileCode2, FileImage, FileText, Folder, MoreHorizontal, RefreshCw, Upload } from 'lucide-react';
import { formatBytes, WORKSPACE_FILE_MIME } from './attachment-types';
import { fetchWorkspaceFile, deleteWorkspaceFiles, listWorkspaceFiles, type UserFileEntry, type WorkspaceUsage } from './client';
import type { WorkspaceSource } from './workspace-files';
import { WorkspaceUploadDialog } from './WorkspaceUploadDialog';
import { workspaceDisplayEntries } from './workspace-display';
import './workspace-file-tree.css';

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

export function WorkspaceFileTree({ source, workspaceId, refreshVersion, onOpenFile, onAttachFile, onFilesChanged,
  revealRequest }: {
  source: WorkspaceSource; workspaceId?: string; refreshVersion: number; onOpenFile(path: string): void;
  onAttachFile?: (path: string, source: WorkspaceSource) => void;
  onFilesChanged?: () => void;
  revealRequest?: { id: number; path: string; source: WorkspaceSource; threadId: string };
}) {
  const [entries, setEntries] = useState<UserFileEntry[]>([]);
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [emphasizePath, setEmphasizePath] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const emphasizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastRevealId = useRef<number | null>(null);
  const currentRevealId = useRef(revealRequest?.id);
  currentRevealId.current = revealRequest?.id;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [manualRefresh, setManualRefresh] = useState(0);
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteFeedback, setDeleteFeedback] = useState<string | null>(null);
  const canManage = source === 'personal';
  const [upload, setUpload] = useState<{ files: File[]; directory: string } | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  async function download(path: string) {
    setMenuPath(null);
    setDownloadError(null);
    try {
      const blob = await fetchWorkspaceFile(path, source);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = path.split('/').at(-1) || 'download';
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setDownloadError(cause instanceof Error ? cause.message : '下载失败'); }
  }

  const loadKey = JSON.stringify([source, workspaceId, refreshVersion, manualRefresh,
    revealRequest?.source === source ? revealRequest.id : null]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setRevealError(null);
    void listWorkspaceFiles(source, workspaceId).then(({ files, usage: nextUsage }) => {
      if (!active) return;
      setEntries(files);
      setLoadedKey(loadKey);
      setUsage(nextUsage ?? null);
      setExpanded(previous => new Set([...previous].filter(path => files.some(file => file.path === path && file.type === 'directory'))));
      setError(null);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '加载文件失败');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadKey]);

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
  const displayEntries = useMemo(() => workspaceDisplayEntries(ordered, source), [ordered, source]);

  useEffect(() => {
    if (!revealRequest || revealRequest.id === lastRevealId.current) return;
    if (revealRequest.source !== source) return;
    if (loading || loadedKey !== loadKey || error) return;
    lastRevealId.current = revealRequest.id;
    const target = revealRequest.path;
    const visibleEntry = displayEntries.find(({ entry }) => entry.path === target);
    if (!visibleEntry) {
      setRevealError('文件已不存在');
      return;
    }
    setRevealError(null);
    // Expand using path prefixes that appear as directories in displayEntries.
    const nextExpanded = new Set(expanded);
    for (const { entry } of displayEntries) {
      if (entry.type === 'directory' && (target === entry.path || target.startsWith(`${entry.path}/`))) {
        nextExpanded.add(entry.path);
      }
    }
    // Also expand logical parents even if intermediate UUID dirs are hidden.
    const parts = target.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i).join('/');
      if (displayEntries.some(({ entry }) => entry.path === prefix && entry.type === 'directory')) {
        nextExpanded.add(prefix);
      }
    }
    setExpanded(nextExpanded);
    setSelectedPath(target);
    if (emphasizeTimer.current) clearTimeout(emphasizeTimer.current);
    setEmphasizePath(target);
    emphasizeTimer.current = setTimeout(() => {
      setEmphasizePath((current) => (current === target ? null : current));
      emphasizeTimer.current = null;
    }, 1500);
    requestAnimationFrame(() => {
      if (currentRevealId.current !== revealRequest.id) return;
      const node = [...document.querySelectorAll('[data-workspace-path]')]
        .find((element) => element.getAttribute('data-workspace-path') === target);
      node?.scrollIntoView({ block: 'center' });
    });
  }, [revealRequest, source, loading, loadedKey, loadKey, error, displayEntries, expanded]);

  useEffect(() => () => {
    if (emphasizeTimer.current) clearTimeout(emphasizeTimer.current);
  }, []);

  const summary = useMemo(() => selectionSummary(selectedPaths, entries), [selectedPaths, entries]);
  const confirmSummary = useMemo(
    () => pendingDelete ? selectionSummary(new Set(pendingDelete), entries) : null,
    [pendingDelete, entries],
  );

  function visible(ancestors: string[]) {
    return ancestors.every(path => expanded.has(path));
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

  return <aside className={`workspace-file-panel${dragOver ? ' is-file-drag-over' : ''}`} aria-label="文件管理"
    onDragOver={event => {
      if (!canManage || !Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragOver(true);
    }}
    onDragLeave={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
    }}
    onDrop={event => {
      setDragOver(false);
      if (!canManage || !Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault(); event.stopPropagation();
      const files = Array.from(event.dataTransfer.files);
      if (!files.length || upload) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-upload-directory]') : null;
      setUpload({ files, directory: target?.dataset.uploadDirectory || 'uploads' });
    }}>
    <div className="workspace-file-heading"><h2>文件管理</h2>
      <div className="workspace-file-heading-actions">
        {canManage && <>
          <input ref={uploadInput} type="file" multiple hidden aria-label="选择上传文件" onChange={event => {
            const files = Array.from(event.target.files ?? []);
            if (files.length) setUpload({ files, directory: 'uploads' });
            event.target.value = '';
          }} />
          <button type="button" title="上传文件" aria-label="上传文件" onClick={() => uploadInput.current?.click()}><Upload size={16} /></button>
        </>}
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
    {canManage && <p className="workspace-upload-hint">拖入文件，选择目录后上传</p>}
    {downloadError && <p role="alert" className="error">{downloadError}</p>}
    {revealError && <p role="alert" className="error">{revealError}</p>}
    {selectionMode && <p className="workspace-file-selection-summary" aria-label="已选摘要">
      已选 {summary.itemCount} 项 · {summary.fileCount} 个文件 · 预计释放 {formatBytes(summary.bytes)}
    </p>}
    {loading && <p role="status" className="muted">加载文件中…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {deleteFeedback && <p role="alert" className={deleteFeedback.includes('失败') ? 'error' : 'muted'}>{deleteFeedback}</p>}
    {!loading && !error && entries.length === 0 && <p className="muted">暂无文件</p>}
    {!error && <ul className="workspace-file-list" aria-label="工作区目录树">{displayEntries
      .filter(item => visible(item.ancestors)).map(({ entry, depth }) => {
      const name = entry.path.split('/').at(-1);
      const isDirectory = entry.type === 'directory';
      const isExpanded = expanded.has(entry.path);
      const protectedPath = isProtectedWorkspacePath(entry.path);
      const showMenu = !selectionMode && !isDirectory;
      return <li key={entry.path} style={{ paddingLeft: `${depth * 14}px` }}
        className={`workspace-file-row${selectedPath === entry.path ? ' workspace-file-row--selected' : ''}${emphasizePath === entry.path ? ' workspace-file-row--emphasize' : ''}`}
        data-workspace-path={entry.path}
        data-upload-directory={isDirectory ? entry.path : undefined}>
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
          <button type="button" role="menuitem" onClick={() => void download(entry.path)}>下载</button>
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
    {upload && <WorkspaceUploadDialog files={upload.files} initialDirectory={upload.directory}
      onClose={() => setUpload(null)} onFileUploaded={() => {
        onFilesChanged?.();
        if (!onFilesChanged) setManualRefresh(value => value + 1);
      }} />}
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
