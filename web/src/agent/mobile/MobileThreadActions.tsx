import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

export function MobileThreadActions({ title, open, onClose, onRename, onDelete }: {
  title: string;
  open: boolean;
  onClose: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'menu' | 'rename' | 'delete'>('menu');
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setMode('menu'); setDraft(title); setError(null); } }, [open, title]);
  if (!open) return null;
  async function rename() {
    const next = draft.trim();
    if (!next) { setError('会话名称不能为空'); return; }
    setBusy(true); setError(null);
    try { await onRename(next); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '修改会话名失败'); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError(null);
    try { await onDelete(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除会话失败'); }
    finally { setBusy(false); }
  }
  return <div className="mobile-thread-actions-backdrop" onClick={onClose}>
    <section className="mobile-thread-actions" role="dialog" aria-modal="true" aria-label="会话操作" onClick={event => event.stopPropagation()}>
      <header><strong>{title}</strong><button type="button" aria-label="关闭会话操作" onClick={onClose}><X size={19} /></button></header>
      {mode === 'menu' && <div className="mobile-thread-actions-options">
        <button type="button" onClick={() => setMode('rename')}>修改会话名</button>
        <button type="button" className="danger" onClick={() => setMode('delete')}>删除会话</button>
      </div>}
      {mode === 'rename' && <form onSubmit={event => { event.preventDefault(); void rename(); }}>
        <label htmlFor="mobile-thread-title">会话名称</label>
        <input id="mobile-thread-title" aria-label="会话名称" value={draft} onChange={event => setDraft(event.target.value)} />
        <div><button type="button" onClick={() => setMode('menu')}>取消</button><button type="submit" disabled={busy}>保存名称</button></div>
      </form>}
      {mode === 'delete' && <div className="mobile-thread-actions-confirm">
        <p>确定删除“{title}”吗？</p>
        <div><button type="button" onClick={() => setMode('menu')}>取消</button>
          <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>确认删除</button></div>
      </div>}
      {error && <p role="alert">{error}</p>}
    </section>
  </div>;
}
