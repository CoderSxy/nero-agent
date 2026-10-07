import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Composer, ComposerActions, ComposerBox, ComposerInput, ComposerRing } from '@mastra/playground-ui/components/Composer';
import { ArrowUp, Check, ChevronDown, Plus, Search, Square } from 'lucide-react';
import type { ModelRef, SafeModel } from './model-catalog-client';

export function AgentComposer({ draft, onDraftChange, isRunning, onSend, onStop, sendDisabled = false,
  catalog = [], modelRef, onModelChange, modelDisabled = false,
  attachments = [], onChooseFile, onDownloadFile }: {
  sendDisabled?: boolean; draft: string; onDraftChange: (value: string) => void; isRunning: boolean;
  onSend: () => void; onStop: () => void;
  catalog?: SafeModel[]; modelRef?: ModelRef; onModelChange?: (ref: ModelRef) => void; modelDisabled?: boolean;
  attachments?: Array<{ id: number; name: string; path?: string }>;
  onChooseFile?: (file: File) => void; onDownloadFile?: (path: string) => void;
}) {
  const available = modelRef && catalog.some(model => model.ref === modelRef);
  const selected = available ? catalog.find(model => model.ref === modelRef) : undefined;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState({ top: 0, left: 0, width: 360 });
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.composer-model-popup, .composer-model-trigger')) setOpen(false);
    };
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const closeOnScroll = () => setOpen(false);
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnKey);
    window.addEventListener('resize', closeOnScroll);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnKey);
      window.removeEventListener('resize', closeOnScroll);
    };
  }, [open]);
  const filtered = catalog.filter(model => [model.displayName, model.modelId, model.providerId]
    .some(text => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  return <Composer className="agent-composer" onSubmit={event => { event.preventDefault(); if (!isRunning && !sendDisabled && draft.trim()) onSend(); }}>
    <ComposerRing busy={isRunning}><ComposerBox>
      <ComposerInput aria-label="发送消息" placeholder="向智能体发送消息…" value={draft}
        onChange={event => onDraftChange(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!isRunning && !sendDisabled && draft.trim()) onSend(); } }} />
      <ComposerActions>
        <button type="button" className="composer-model-trigger" role="combobox" aria-label="模型"
          aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? 'composer-model-options' : undefined}
          title="会话与记忆模型" disabled={isRunning || modelDisabled || catalog.length === 0}
          onClick={event => {
            if (open) { setOpen(false); return; }
            const rect = event.currentTarget.getBoundingClientRect();
            const width = Math.min(360, window.innerWidth - 16);
            setPosition({ top: Math.max(8, rect.top - 392), left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8), width });
            setQuery(''); setOpen(true);
          }}>
          <span className="composer-model-avatar" aria-hidden="true">{selected?.providerId.slice(0, 1).toUpperCase() || 'M'}</span>
          <span className="composer-model-name">{selected?.displayName || (catalog.length ? '选择模型' : '暂无可用模型')}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {open && createPortal(<div className="composer-model-popup" style={position}>
          <div className="composer-model-search"><Search size={16} aria-hidden="true" />
            <input ref={searchRef} type="search" aria-label="搜索模型" placeholder="搜索模型名或 ID"
              value={query} onChange={event => setQuery(event.target.value)} />
          </div>
          <div id="composer-model-options" role="listbox" aria-label="选择模型" className="composer-model-options">
            {(['public', 'private'] as const).map(scope => {
              const items = filtered.filter(model => model.scope === scope);
              if (!items.length) return null;
              return <div key={scope} className="composer-model-group">
                <div className="composer-model-group-label">{scope === 'public' ? '公共模型' : '我的模型'}</div>
                {items.map(model => <button type="button" key={model.ref} role="option"
                  aria-selected={model.ref === modelRef} className="composer-model-option"
                  onClick={() => { onModelChange?.(model.ref); setOpen(false); }}>
                  <span className="composer-model-avatar" aria-hidden="true">{model.providerId.slice(0, 1).toUpperCase()}</span>
                  <span className="composer-model-detail"><strong>{model.displayName}</strong>
                    <small>{model.providerId} / {model.modelId}</small></span>
                  {model.isDefault && <span className="composer-model-default">默认</span>}
                  {model.ref === modelRef && <Check size={15} aria-hidden="true" />}
                </button>)}
              </div>;
            })}
            {!filtered.length && <p className="composer-model-empty">没有匹配的模型</p>}
          </div>
        </div>, document.body)}
        <div className="composer-file-controls">
          {attachments.length > 0 && <div className="composer-attachments" aria-label="已选择的文件">
            {attachments.map(file => file.path
              ? <button key={file.id} type="button" className="composer-attachment" title={file.name}
                aria-label={`下载 ${file.name}`} onClick={() => onDownloadFile?.(file.path!)}>{file.name}</button>
              : <span key={file.id} className="composer-attachment" title={`${file.name} 上传中`}>{file.name}</span>)}
          </div>}
          <input ref={fileInputRef} className="composer-file-input" type="file" aria-label="选择文件"
            onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onChooseFile?.(file);
            }} />
          <button type="button" className="composer-add-button" aria-label="添加文件" title="添加文件"
            onClick={() => fileInputRef.current?.click()}><Plus size={18} aria-hidden="true" /></button>
          {isRunning ? <button className="composer-send-button" type="button" aria-label="停止" title="停止"
            onClick={onStop}><Square size={16} fill="currentColor" aria-hidden="true" /></button>
            : <button className="composer-send-button" type="submit" aria-label="发送" title="发送"
              disabled={sendDisabled || !draft.trim()}><ArrowUp size={18} aria-hidden="true" /></button>}
        </div>
      </ComposerActions>
    </ComposerBox></ComposerRing>
  </Composer>;
}
