import { useCallback, useEffect, useState } from 'react';
import { fetchWorkspaceFile, listWorkspaceFiles,
  type UserFileEntry } from './client';

export function ThreadFiles({ source = 'personal', workspaceId, refreshVersion = 0 }: {
  source?: 'personal' | 'agent'; workspaceId?: string; refreshVersion?: number;
}) {
  const [files, setFiles] = useState<UserFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const refresh = useCallback(async (active: () => boolean = () => true) => {
    setLoading(true);
    try {
      const next = await listWorkspaceFiles(source, workspaceId);
      if (active()) { setFiles(next); setError(null); }
    } catch (cause) {
      if (active()) setError(cause instanceof Error ? cause.message : '加载文件失败');
    } finally { if (active()) setLoading(false); }
  }, [source, workspaceId]);
  useEffect(() => {
    let active = true;
    void refresh(() => active);
    return () => { active = false; };
  }, [refresh, refreshVersion]);
  async function download(path: string) {
    try {
      const blob = await fetchWorkspaceFile(path, source);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = path.split('/').at(-1) ?? 'download';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDownloadError(null);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : '下载失败');
    }
  }
  const orderedFiles = [...files].sort((left, right) => {
    const leftSegments = left.path.split('/');
    const rightSegments = right.path.split('/');
    for (let index = 0; index < Math.min(leftSegments.length, rightSegments.length); index++) {
      const order = leftSegments[index].localeCompare(rightSegments[index], 'zh');
      if (order) return order;
    }
    return leftSegments.length - rightSegments.length;
  });
  return <div className="thread-files">
    <div className="thread-files-heading"><strong>{source === 'agent' ? 'Agent 工作区文件' : '我的工作区文件'}</strong>
      <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="刷新文件">刷新</button>
    </div>
    {loading && <p className="muted" role="status">加载文件中…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {downloadError && <p role="alert" className="error">{downloadError}</p>}
    {!loading && !error && files.length === 0 && <p className="muted">暂无文件</p>}
    {!error && orderedFiles.length > 0 && <ul aria-label="工作区目录树">{orderedFiles.map(file =>
      <li key={file.path} style={{ paddingLeft: `${(file.path.split('/').length - 1) * 14}px` }}
        title={file.path}>{file.type === 'file'
        ? <button type="button" onClick={() => void download(file.path)}
          aria-label={`下载 ${file.path}`}><span aria-hidden="true">📄 </span>{file.path.split('/').at(-1)}</button>
        : <span><span aria-hidden="true">📁 </span><span>{file.path.split('/').at(-1)}/</span></span>}</li>)}</ul>}
  </div>;
}
