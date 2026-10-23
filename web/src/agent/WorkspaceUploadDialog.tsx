import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder, Upload, X } from 'lucide-react';
import { listWorkspaceFiles, uploadWorkspaceFile } from './client';
import { formatBytes, MAX_UPLOAD_BYTES } from './attachment-types';
import { workspaceDisplayEntries } from './workspace-display';
import './workspace-upload.css';

export function WorkspaceUploadDialog({ files, initialDirectory = 'uploads', attachToComposer = false,
  onConfirm, onFileUploaded, onClose }: {
  files: File[]; initialDirectory?: string; attachToComposer?: boolean;
  onConfirm?: (files: File[], directory: string) => void;
  onFileUploaded?: () => void; onClose(): void;
}) {
  const [directories, setDirectories] = useState<string[]>([]);
  const [directory, setDirectory] = useState(initialDirectory);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [done, setDone] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    let active = true;
    void listWorkspaceFiles('personal').then(({ files: entries }) => {
      if (!active) return;
      setDirectories(workspaceDisplayEntries(entries, 'personal').filter(({ entry }) => entry.type === 'directory'
        && !entry.path.split('/').some(part => part.startsWith('.'))).map(({ entry }) => entry.path).sort());
    }).catch(cause => { if (active) setLoadError(cause instanceof Error ? cause.message : '加载目录失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; if (previous instanceof HTMLElement) previous.focus(); };
  }, []);

  async function confirm() {
    if (submitting.current || loading || loadError) return;
    if (onConfirm) { onConfirm(files, directory); onClose(); return; }
    submitting.current = true;
    setBusy(true);
    const failed: Record<number, string> = {};
    for (const [index, file] of files.entries()) {
      if (done.has(index)) continue;
      try {
        if (file.size > MAX_UPLOAD_BYTES) throw new Error('文件超过 10 MiB 上限');
        await uploadWorkspaceFile(file, directory);
        setDone(current => new Set([...current, index]));
        onFileUploaded?.();
      } catch (cause) { failed[index] = cause instanceof Error ? cause.message : '上传失败'; }
    }
    setErrors(failed);
    setBusy(false);
    submitting.current = false;
    if (Object.keys(failed).length === 0) onClose();
  }

  return createPortal(<div className="workspace-upload-backdrop" onPointerDown={event => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <div ref={dialog} className="workspace-upload-dialog" role="dialog" aria-modal="true" aria-label="上传到工作区"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose(); }
        if (event.key !== 'Tab') return;
        const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)');
        if (!items?.length) return;
        const first = items[0]!; const last = items[items.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <header><div><h2>上传到工作区</h2><p>{attachToComposer ? '上传后加入当前消息附件' : '文件仅保存到工作区'}</p></div>
        <button type="button" aria-label="关闭上传弹窗" disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <label className="workspace-upload-label" htmlFor="workspace-upload-directory"><Folder size={16} />目标目录</label>
      <select id="workspace-upload-directory" value={directory} disabled={busy || loading || Boolean(loadError) || done.size > 0}
        onChange={event => setDirectory(event.target.value)}>
        {[...new Set([initialDirectory, 'uploads', ...directories])].map(path => <option key={path} value={path}>{path}</option>)}
      </select>
      {loading && <p role="status">加载目录中…</p>}
      {loadError && <p role="alert" className="error">{loadError}</p>}
      <ul className="workspace-upload-files">{files.map((file, index) => <li key={index}>
        <span title={file.name}>{file.name}</span><small>{formatBytes(file.size)}</small>
        {done.has(index) && <small>已上传</small>}
        {errors[index] && <p role="alert" className="error">{errors[index]}</p>}
      </li>)}</ul>
      <footer><span aria-live="polite">{busy ? `已上传 ${done.size} / ${files.length}` : `共 ${files.length} 个文件`}</span>
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="workspace-upload-submit" disabled={busy || loading || Boolean(loadError)} onClick={() => void confirm()}>
          <Upload size={15} />{busy ? '上传中…' : Object.keys(errors).length ? '重试失败文件' : '开始上传'}</button>
      </footer>
    </div>
  </div>, document.body);
}
