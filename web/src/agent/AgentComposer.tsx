import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { Composer, ComposerActions, ComposerBox, ComposerInput, ComposerRing } from '@mastra/playground-ui/components/Composer';
import { ArrowUp, Check, ChevronDown, Plus, Search, Square, X } from 'lucide-react';
import { fetchWorkspaceFile } from './client';
import {
  formatBytes, IMAGE_ACCEPT, isImageAttachment, type ComposerAttachment,
} from './attachment-types';
import type { ModelRef, SafeModel } from './model-catalog-client';

function AttachmentCard({ attachment, onRemove, onRetry, onPreview }: {
  attachment: ComposerAttachment;
  onRemove?: (key: string) => void;
  onRetry?: (key: string) => void;
  onPreview?: (attachment: ComposerAttachment, url: string) => void;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const isImage = isImageAttachment(attachment) && attachment.state === 'ready' && attachment.path;

  useEffect(() => {
    if (!isImage) return;
    let active = true;
    let objectUrl: string | null = null;
    void fetchWorkspaceFile(attachment.path, attachment.source).then(blob => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setThumbUrl(objectUrl);
    }).catch(() => { if (active) setThumbUrl(null); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isImage, attachment.path, attachment.source]);

  const title = attachment.path || attachment.name;
  return <div className={`composer-attachment-card${attachment.state === 'failed' ? ' is-failed' : ''}`}
    aria-label={`附件 ${attachment.name}`} title={title}>
    {isImage && thumbUrl ? <button type="button" className="composer-attachment-thumb" aria-label={`预览 ${attachment.name}`}
      onClick={() => onPreview?.(attachment, thumbUrl)}>
      <img src={thumbUrl} alt={attachment.name} />
    </button> : <div className="composer-attachment-meta">
      <strong>{attachment.name}</strong>
      <small>{attachment.state === 'uploading' ? '上传中…'
        : attachment.state === 'failed' ? (attachment.error || '上传失败')
          : formatBytes(attachment.size)}</small>
    </div>}
    {attachment.state === 'failed' && <button type="button" className="composer-attachment-retry"
      aria-label={`重试 ${attachment.name}`} onClick={() => onRetry?.(attachment.key)}>重试</button>}
    <button type="button" className="composer-attachment-remove"
      aria-label={`从本次消息移除 ${attachment.name}`} onClick={() => onRemove?.(attachment.key)}>
      <X size={12} aria-hidden="true" />
    </button>
  </div>;
}

export function AgentComposer({ draft, onDraftChange, isRunning, onSend, onStop, sendDisabled = false,
  catalog = [], modelRef, onModelChange, modelDisabled = false,
  attachments = [], onChooseWorkspaceFiles, onUploadFiles, onRemoveAttachment, onRetryAttachment }: {
  sendDisabled?: boolean; draft: string; onDraftChange: (value: string) => void; isRunning: boolean;
  onSend: () => void; onStop: () => void;
  catalog?: SafeModel[]; modelRef?: ModelRef; onModelChange?: (ref: ModelRef) => void; modelDisabled?: boolean;
  attachments?: ComposerAttachment[];
  onChooseWorkspaceFiles?: () => void;
  onUploadFiles?: (files: File[], kind: 'file' | 'image') => void;
  onRemoveAttachment?: (key: string) => void;
  onRetryAttachment?: (key: string) => void;
}) {
  const available = modelRef && catalog.some(model => model.ref === modelRef);
  const selected = available ? catalog.find(model => model.ref === modelRef) : undefined;
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addPosition, setAddPosition] = useState({ top: 0, left: 0 });
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState({ top: 0, left: 0, width: 360 });
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentBusy = attachments.some(item => item.state === 'uploading' || item.state === 'failed');
  const canSend = !isRunning && !sendDisabled && !attachmentBusy && Boolean(draft.trim());

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
  useEffect(() => {
    if (!addOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.composer-add-menu, .composer-add-button')) setAddOpen(false);
    };
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setAddOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnKey);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnKey);
    };
  }, [addOpen]);

  const filtered = catalog.filter(model => [model.displayName, model.modelId, model.providerId]
    .some(text => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));

  function pickFiles(kind: 'file' | 'image') {
    setAddOpen(false);
    if (kind === 'image') imageInputRef.current?.click();
    else fileInputRef.current?.click();
  }

  function onFileInput(kind: 'file' | 'image', event: ChangeEvent<HTMLInputElement>) {
    const list = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (list.length) onUploadFiles?.(list, kind);
  }

  return <Composer className="agent-composer" onSubmit={event => { event.preventDefault(); if (canSend) onSend(); }}>
    {attachments.length > 0 && <div className="composer-attachment-row" aria-label="已选择的文件">
      {attachments.map(file => <AttachmentCard key={file.key} attachment={file}
        onRemove={onRemoveAttachment} onRetry={onRetryAttachment}
        onPreview={(item, url) => setPreview({ name: item.name, url })} />)}
    </div>}
    <ComposerRing busy={isRunning}><ComposerBox>
      <ComposerInput aria-label="发送消息" placeholder="向智能体发送消息…" value={draft}
        onChange={event => onDraftChange(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (canSend) onSend(); } }} />
      <ComposerActions>
        <button type="button" className="composer-model-trigger" role="combobox" aria-label="模型"
          aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? 'composer-model-options' : undefined}
          title="会话与记忆模型" disabled={isRunning || modelDisabled || catalog.length === 0}
          onClick={event => {
            if (open) { setOpen(false); return; }
            const rect = event.currentTarget.getBoundingClientRect();
            const width = Math.min(360, window.innerWidth - 16);
            setPosition({ top: Math.max(8, rect.top - 392), left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8), width });
            setQuery(''); setOpen(true); setAddOpen(false);
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
          <input ref={fileInputRef} className="composer-file-input" type="file" multiple
            aria-label="选择本地文件" onChange={event => onFileInput('file', event)} />
          <input ref={imageInputRef} className="composer-file-input" type="file" multiple accept={IMAGE_ACCEPT}
            aria-label="选择图片" onChange={event => onFileInput('image', event)} />
          <button type="button" className="composer-add-button" aria-label="添加附件" title="添加附件"
            aria-haspopup="menu" aria-expanded={addOpen}
            onClick={event => {
              if (addOpen) { setAddOpen(false); return; }
              const rect = event.currentTarget.getBoundingClientRect();
              setAddPosition({ top: Math.max(8, rect.top - 140), left: Math.min(rect.left, window.innerWidth - 180) });
              setAddOpen(true); setOpen(false);
            }}><Plus size={18} aria-hidden="true" /></button>
          {addOpen && createPortal(<div className="composer-add-menu" role="menu" aria-label="添加附件"
            style={addPosition}>
            <button type="button" role="menuitem" onClick={() => pickFiles('file')}>上传文件</button>
            <button type="button" role="menuitem" onClick={() => { setAddOpen(false); onChooseWorkspaceFiles?.(); }}>
              选择工作区文件</button>
            <button type="button" role="menuitem" onClick={() => pickFiles('image')}>添加图片</button>
          </div>, document.body)}
          {isRunning ? <button className="composer-send-button" type="button" aria-label="停止" title="停止"
            onClick={onStop}><Square size={16} fill="currentColor" aria-hidden="true" /></button>
            : <button className="composer-send-button" type="submit" aria-label="发送" title="发送"
              disabled={!canSend}><ArrowUp size={18} aria-hidden="true" /></button>}
        </div>
      </ComposerActions>
    </ComposerBox></ComposerRing>
    {preview && createPortal(<div className="composer-image-preview-backdrop" role="dialog" aria-label="图片预览">
      <button type="button" className="composer-image-preview-close" aria-label="关闭预览"
        onClick={() => setPreview(null)}>关闭</button>
      <img src={preview.url} alt={preview.name} />
    </div>, document.body)}
  </Composer>;
}
