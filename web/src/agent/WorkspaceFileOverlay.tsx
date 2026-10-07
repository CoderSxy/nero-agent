import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Download, Save, X } from 'lucide-react';
import { openWorkspaceFile, saveWorkspaceFile, type OpenWorkspaceFile, type WorkspaceSource } from './workspace-files';

const TextEditor = lazy(() => import('./previews/TextEditor').then(module => ({ default: module.TextEditor })));
const ReadOnlyPreview = lazy(() => import('./previews/ReadOnlyPreview').then(module => ({ default: module.ReadOnlyPreview })));

type FileState = OpenWorkspaceFile & { path: string; source: WorkspaceSource };
type Pending = { type: 'close' } | { type: 'switch'; path: string; source: WorkspaceSource };

export function WorkspaceFileOverlay({ request, source, onClosed, onSaved }: {
  request: { path: string; id: number }; source: WorkspaceSource; onClosed(): void; onSaved(): void;
}) {
  const [file, setFile] = useState<FileState | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const sequence = useRef(0);
  const currentFile = useRef<FileState | null>(null);
  const currentDraft = useRef('');
  const pendingAction = useRef<Pending | null>(null);
  const dirty = Boolean(file && file.text !== undefined && file.text !== draft);

  function updateDraft(value: string) { currentDraft.current = value; setDraft(value); }
  function updateFile(value: FileState | null) { currentFile.current = value; setFile(value); }
  function updatePending(value: Pending | null) { pendingAction.current = value; setPending(value); }

  async function load(path: string, selectedSource: WorkspaceSource) {
    const id = ++sequence.current;
    setLoading(true); setError(null); updateFile(null); updateDraft('');
    try {
      const result = await openWorkspaceFile(path, selectedSource);
      if (id !== sequence.current) return;
      updateFile({ ...result, path, source: selectedSource });
      updateDraft(result.text ?? '');
    } catch (cause) {
      if (id === sequence.current) setError(cause instanceof Error ? cause.message : '读取文件失败');
    } finally { if (id === sequence.current) setLoading(false); }
  }

  useEffect(() => {
    const current = currentFile.current;
    if (current?.path === request.path && current.source === source) return;
    if (current && current.text !== undefined && current.text !== currentDraft.current) {
      updatePending({ type: 'switch', path: request.path, source });
      return;
    }
    void load(request.path, source);
  }, [request.id, source]);
  useEffect(() => () => { sequence.current++; }, []);

  async function save(): Promise<boolean> {
    const current = currentFile.current;
    if (!current || current.text === undefined || !current.etag || saving) return false;
    const submitted = currentDraft.current;
    setSaving(true); setError(null);
    try {
      const nextEtag = await saveWorkspaceFile(current.path, current.source, submitted, current.etag);
      updateFile({ ...current, text: submitted, etag: nextEtag });
      onSaved();
      return currentDraft.current === submitted;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存文件失败');
      return false;
    } finally { setSaving(false); }
  }

  function finish(choice: Pending) {
    updatePending(null);
    if (choice.type === 'close') onClosed();
    else void load(choice.path, choice.source);
  }
  function close() { if (dirty) updatePending({ type: 'close' }); else onClosed(); }
  function download() {
    if (!file) return;
    const url = URL.createObjectURL(file.blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = file.path.split('/').at(-1) ?? 'download'; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return <section className="workspace-file-overlay" aria-label="文件预览编辑"
    onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); if (dirty) void save();
      }
    }}>
    <header className="workspace-overlay-header">
      <div><strong>{file?.path.split('/').at(-1) ?? request.path.split('/').at(-1)}</strong>
        <small title={file?.path ?? request.path}>{file?.path ?? request.path}</small></div>
      <div className="workspace-overlay-actions">
        {dirty && <span className="workspace-unsaved">未保存</span>}
        {file && <button type="button" aria-label="下载文件" title="下载" onClick={download}><Download size={17} /></button>}
        {file?.text !== undefined && <button type="button" aria-label="保存文件" title="保存" disabled={!dirty || saving || !file.etag}
          onClick={() => void save()}><Save size={17} /></button>}
        <button type="button" aria-label="关闭文件" title="关闭" onClick={close}><X size={19} /></button>
      </div>
    </header>
    {error && <p role="alert" className="workspace-overlay-error">{error}</p>}
    <div className="workspace-overlay-body">
      {loading && <p role="status">加载文件中…</p>}
      {file && <Suspense fallback={<p role="status">加载预览组件中…</p>}>
        {file.text !== undefined ? <TextEditor path={file.path} kind={file.kind} value={draft} onChange={updateDraft} />
          : <ReadOnlyPreview name={file.path.split('/').at(-1) ?? file.path} kind={file.kind} blob={file.blob} onDownload={download} />}
      </Suspense>}
    </div>
    {pending && <div className="workspace-confirm-backdrop"><div role="dialog" aria-modal="true" aria-label="未保存的修改"
      className="workspace-confirm">
      <h3>未保存的修改</h3><p>此文件已修改，是否保存？</p>
      <div>
        <button type="button" disabled={saving} onClick={() => updatePending(null)}>继续编辑</button>
        <button type="button" disabled={saving} onClick={() => finish(pendingAction.current ?? pending)}>
          {pending.type === 'close' ? '放弃修改并关闭' : '放弃修改并继续'}</button>
        <button type="button" disabled={saving} onClick={() => void save().then(ok => {
          if (ok) finish(pendingAction.current ?? pending);
        })}>
          {pending.type === 'close' ? '保存并关闭' : '保存并继续'}</button>
      </div>
    </div></div>}
  </section>;
}
