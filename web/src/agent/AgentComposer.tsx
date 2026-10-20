import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { Composer, ComposerActions, ComposerBox, ComposerInput, ComposerRing } from '@mastra/playground-ui/components/Composer';
import { ArrowUp, Check, ChevronDown, Plus, Search, Square, X } from 'lucide-react';
import { fetchWorkspaceFile } from './client';
import {
  formatBytes, IMAGE_ACCEPT, IMAGE_MIME, isImageAttachment, WORKSPACE_FILE_MIME, type ComposerAttachment,
} from './attachment-types';
import type { ModelRef, SafeModel } from './model-catalog-client';
import { financeCategoryOptions, type FinanceCategory } from './finance-category';
import { SkillPicker, type SkillPickerHandle } from './skills/SkillPicker';
import { SkillSelectionChips } from './skills/SkillSelectionChips';
import { SkillShortcutDock } from './skills/SkillShortcutForm';
import { limitSkillIds } from './skills/selection';
import { replaceSkillSlash, resolveSkillSlash, type SkillSlashMatch } from './skills/skill-slash';
import type { SkillSummary } from './skills/types';

function modelFacts(model: SafeModel): string {
  const meta = model.catalogMetadata;
  const credit = meta?.creditLabel ?? (meta?.creditMultiplier === undefined ? null : `x${meta.creditMultiplier.toFixed(2)}`);
  const modality = model.supportsVision
    ? '支持图片'
    : meta?.modality === 'unverified' || meta?.imageSupport === null
      ? '图片待核实'
      : meta?.modality === 'router'
        ? '自动路由'
        : '文本';
  return [credit, modality, meta?.inferenceOnly ? '仅推理' : null, meta?.providerName ?? model.providerId]
    .filter(Boolean)
    .join(' · ');
}

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

export type WorkspaceDragItem = {
  source: 'personal' | 'agent';
  path: string;
  name: string;
  size: number;
  mimeType: string;
};

function dragHasFiles(transfer: DataTransfer | null | undefined): boolean {
  if (!transfer) return false;
  const types = Array.from(transfer.types ?? []);
  return types.includes('Files') || types.includes(WORKSPACE_FILE_MIME);
}

export function AgentComposer({ draft, onDraftChange, isRunning, onSend, onStop, sendDisabled = false,
  catalog = [], modelRef, onModelChange, modelDisabled = false,
  financeCategory = null, financeEnabled = false, financeSaving = false, onFinanceCategoryChange,
  attachments = [], onChooseWorkspaceFiles, onUploadFiles, onRemoveAttachment, onRetryAttachment,
  onWorkspaceDrop, onInputFocus, autoFocus = false, attachmentsDisabled = false, mobileInline = false,
  selectedSkillIds, onSelectedSkillIdsChange, skillScopeKey, preserveMissingSkills = false }: {
  sendDisabled?: boolean; draft: string; onDraftChange: (value: string) => void; isRunning: boolean;
  financeCategory?: FinanceCategory | null; financeEnabled?: boolean; financeSaving?: boolean;
  onFinanceCategoryChange?: (value: FinanceCategory | null) => void;
  onSend: () => void; onStop: () => void;
  onInputFocus?: () => void; autoFocus?: boolean; attachmentsDisabled?: boolean;
  mobileInline?: boolean;
  catalog?: SafeModel[]; modelRef?: ModelRef; onModelChange?: (ref: ModelRef) => void; modelDisabled?: boolean;
  attachments?: ComposerAttachment[];
  onChooseWorkspaceFiles?: () => void;
  onUploadFiles?: (files: File[], kind: 'file' | 'image') => void;
  onRemoveAttachment?: (key: string) => void;
  onRetryAttachment?: (key: string) => void;
  onWorkspaceDrop?: (items: WorkspaceDragItem[]) => void;
  selectedSkillIds?: string[];
  onSelectedSkillIdsChange?: (ids: string[]) => void;
  skillScopeKey?: string;
  preserveMissingSkills?: boolean;
}) {
  const available = modelRef && catalog.some(model => model.ref === modelRef);
  const selected = available ? catalog.find(model => model.ref === modelRef) : undefined;
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [financeOpen, setFinanceOpen] = useState(false);
  const [addPosition, setAddPosition] = useState({ top: 0, left: 0 });
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState({ top: 0, left: 0, width: 360 });
  const [preview, setPreview] = useState<{ key: string; name: string; url: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<SkillPickerHandle>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillMode, setSkillMode] = useState<'slash' | 'search'>('slash');
  const [skillQuery, setSkillQuery] = useState('');
  const [skillCatalog, setSkillCatalog] = useState<SkillSummary[]>([]);
  const [skillPhase, setSkillPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [skillPosition, setSkillPosition] = useState<{ left: number; width: number; maxHeight: number; top?: number; bottom?: number }>({ left: 8, width: 320, maxHeight: 360, bottom: 8 });
  const dismissedRef = useRef<{ start: number; end: number; token: string } | null>(null);
  const matchRef = useRef<SkillSlashMatch | null>(null);
  const draftRef = useRef(draft);
  const modeRef = useRef(skillMode);
  const composingRef = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const pickGeneration = useRef(0);
  draftRef.current = draft;
  modeRef.current = skillMode;
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentBusy = attachments.some(item => item.state === 'uploading' || item.state === 'failed');
  const hasReadyAttachment = attachments.some(item => item.state === 'ready');
  const imageUnsupported = attachments.some(isImageAttachment) && selected?.supportsVision === false;
  const canSend = !isRunning && !sendDisabled && !financeSaving && !attachmentBusy && !imageUnsupported
    && (Boolean(draft.trim()) || hasReadyAttachment);

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (attachmentsDisabled) return;
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (attachmentsDisabled) return;
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    const workspaceRaw = event.dataTransfer.getData(WORKSPACE_FILE_MIME);
    if (workspaceRaw) {
      try {
        const parsed = JSON.parse(workspaceRaw) as WorkspaceDragItem | WorkspaceDragItem[];
        const items = Array.isArray(parsed) ? parsed : [parsed];
        onWorkspaceDrop?.(items.filter(item => item?.path));
      } catch { /* ignore malformed payload */ }
      return;
    }
    const files = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
    if (!files.length) return;
    const images = files.filter(file => IMAGE_MIME.has(file.type)
      || /\.(png|jpe?g|webp|gif)$/i.test(file.name));
    const others = files.filter(file => !images.includes(file));
    if (images.length) onUploadFiles?.(images, 'image');
    if (others.length) onUploadFiles?.(others, 'file');
  }

  function onPaste(event: ClipboardEvent<HTMLDivElement>) {
    if (attachmentsDisabled) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    const images: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && /^image\/(png|jpeg|webp|gif)$/i.test(item.type)) {
        const file = item.getAsFile();
        if (file) images.push(file);
      }
    }
    if (!images.length) return;
    event.preventDefault();
    onUploadFiles?.(images, 'image');
  }

  useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);
  useEffect(() => { if (modelDisabled) setOpen(false); }, [modelDisabled]);
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

  function removeAttachment(key: string) {
    if (preview?.key === key) setPreview(null);
    onRemoveAttachment?.(key);
  }

  function closePreview() {
    setPreview(null);
  }

  function dismissSkillPanel() {
    const current = matchRef.current;
    if (current && modeRef.current === 'slash') {
      dismissedRef.current = {
        start: current.start,
        end: current.end,
        token: draftRef.current.slice(current.start, current.end),
      };
    }
    setSkillOpen(false);
  }

  function updateFromCaret(text: string, start: number, end: number) {
    if (isRunning || mobileInline) return;
    const next = resolveSkillSlash(text, start, end);
    matchRef.current = next;
    if (!next) {
      if (modeRef.current === 'slash') setSkillOpen(false);
      return;
    }
    const token = text.slice(next.start, next.end);
    const dismissed = dismissedRef.current;
    if (dismissed && dismissed.token === token && dismissed.start === next.start && dismissed.end === next.end) {
      setSkillOpen(false);
      return;
    }
    dismissedRef.current = null;
    setSkillMode('slash');
    setSkillQuery(next.query);
    placeSkillPopover();
    setSkillOpen(true);
    setOpen(false);
    setAddOpen(false);
  }

  function applyPickedSkill() {
    const generation = pickGeneration.current;
    const current = matchRef.current;
    if (modeRef.current === 'slash' && current && generation === pickGeneration.current) {
      const replaced = replaceSkillSlash(draftRef.current, current);
      onDraftChange(replaced.text);
      matchRef.current = null;
      dismissedRef.current = null;
      pendingCaret.current = replaced.caret;
    }
    setSkillOpen(false);
  }

  useEffect(() => {
    if (pendingCaret.current === null) return;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(caret, caret);
  }, [draft]);

  useEffect(() => {
    pickGeneration.current += 1;
    setSkillOpen(false);
    matchRef.current = null;
    dismissedRef.current = null;
  }, [skillScopeKey, isRunning]);

  function placeSkillPopover() {
    const root = composerRef.current;
    if (!root || mobileInline) return;
    const box = root.querySelector('[data-slot="composer-box"]');
    const anchor = box instanceof HTMLElement ? box : root;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const gap = 10;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const width = Math.min(rect.width, Math.max(240, viewportWidth - margin * 2));
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - width - margin));
    const spaceAbove = rect.top - gap - margin;
    const spaceBelow = viewportHeight - rect.bottom - gap - margin;
    if (spaceAbove < 200 && spaceBelow > spaceAbove) {
      setSkillPosition({
        top: rect.bottom + gap,
        left,
        width,
        maxHeight: Math.max(160, Math.min(420, spaceBelow)),
      });
      return;
    }
    setSkillPosition({
      bottom: viewportHeight - rect.top + gap,
      left,
      width,
      maxHeight: Math.max(160, Math.min(420, spaceAbove)),
    });
  }

  useEffect(() => {
    if (!skillOpen || mobileInline) return;
    const place = () => placeSkillPopover();
    place();
    const view = window.visualViewport;
    const observed = composerRef.current;
    const box = observed?.querySelector('[data-slot="composer-box"]');
    const observer = new ResizeObserver(place);
    if (observed) observer.observe(observed);
    if (box) observer.observe(box);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    view?.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      view?.removeEventListener('resize', place);
    };
  }, [skillOpen, mobileInline]);

  useEffect(() => {
    if (!skillOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target instanceof Element && target.closest('.skill-picker-popover, .composer-skill-button')) return;
      dismissSkillPanel();
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [skillOpen]);

  return <div ref={composerRef} className={`agent-composer${mobileInline ? ' mobile-inline-composer' : ''}`}
    onDragOver={onDragOver} onDrop={onDrop} onPaste={onPaste}>
    {onSelectedSkillIdsChange && <SkillShortcutDock disabled={isRunning || sendDisabled} scopeKey={skillScopeKey}
      suppressStatus={skillOpen && skillPhase === 'error'}
      onApply={({ skillId, text }) => {
        onDraftChange(text);
        onSelectedSkillIdsChange(limitSkillIds([
          skillId,
          ...(selectedSkillIds ?? []).filter(id => id !== skillId),
        ]));
      }} />}
    <div className="composer-finance-row">
      <div className="composer-finance-picker">
        <button type="button" aria-label="财经数据" aria-expanded={financeOpen} disabled={financeSaving || isRunning}
          onClick={() => setFinanceOpen(value => !value)}>财经数据 <ChevronDown size={14} aria-hidden="true" /></button>
        {financeOpen && <div className="composer-finance-menu" role="menu" aria-label="财经数据分类">
          {financeCategoryOptions.map(option => <button key={option.value} type="button" role="menuitem"
            disabled={financeSaving} onClick={() => { setFinanceOpen(false); onFinanceCategoryChange?.(option.value); }}>
            {option.label}</button>)}
        </div>}
      </div>
      {financeCategory && <span className={`composer-finance-chip${financeEnabled ? '' : ' is-inactive'}`}>
        财经数据 · {financeCategoryOptions.find(option => option.value === financeCategory)?.label}
        {!financeEnabled && '（暂不可用）'}
        <button type="button" aria-label="移除财经分类" disabled={financeSaving || isRunning}
          onClick={() => onFinanceCategoryChange?.(null)}><X size={13} aria-hidden="true" /></button>
      </span>}
      {financeSaving && <span role="status">保存分类中…</span>}
    </div>
    <Composer onSubmit={event => { event.preventDefault(); if (canSend) onSend(); }}>
    {attachments.length > 0 && <div className="composer-attachment-row" aria-label="已选择的文件">
      {attachments.map(file => <AttachmentCard key={file.key} attachment={file}
        onRemove={removeAttachment} onRetry={onRetryAttachment}
        onPreview={(item, url) => setPreview({ key: item.key, name: item.name, url })} />)}
    </div>}
    {imageUnsupported && <p className="composer-image-warning" role="status">
      当前模型不支持图片，请切换支持图片的模型
    </p>}
    <ComposerRing busy={isRunning}><ComposerBox>
      {onSelectedSkillIdsChange && <SkillSelectionChips value={selectedSkillIds ?? []} catalog={skillCatalog}
        phase={skillPhase} disabled={isRunning || sendDisabled} preserveMissing={preserveMissingSkills}
        onRemove={id => onSelectedSkillIdsChange((selectedSkillIds ?? []).filter(item => item !== id))} />}
      <ComposerInput ref={inputRef} aria-label="发送消息" placeholder={mobileInline ? '向智能体发送消息…' : '向智能体发送消息，输入 / 选择技能…'} value={draft}
        autoFocus={autoFocus} onFocus={onInputFocus}
        onChange={event => {
          onDraftChange(event.target.value);
          updateFromCaret(event.target.value, event.target.selectionStart ?? event.target.value.length, event.target.selectionEnd ?? event.target.value.length);
        }}
        onSelect={event => {
          const target = event.target as HTMLTextAreaElement;
          updateFromCaret(target.value, target.selectionStart ?? 0, target.selectionEnd ?? 0);
        }}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={event => {
          composingRef.current = false;
          const target = event.target as HTMLTextAreaElement;
          updateFromCaret(target.value, target.selectionStart ?? target.value.length, target.selectionEnd ?? target.value.length);
        }}
        onKeyDown={event => {
          const native = event.nativeEvent;
          if (composingRef.current || native.isComposing || native.keyCode === 229) return;
          if (event.key === 'Tab' && skillOpen) {
            dismissSkillPanel();
            return;
          }
          if (event.key === 'Enter' && event.shiftKey) return;
          if (pickerRef.current?.handleKeyDown(event)) return;
          if (event.key !== 'Enter' || skillOpen) {
            if (event.key === 'Enter') event.preventDefault();
            return;
          }
          event.preventDefault();
          if (canSend) onSend();
        }} />
      <ComposerActions>
        <button type="button" className="composer-model-trigger" role="combobox" aria-label="模型"
          aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? 'composer-model-options' : undefined}
          title="会话与记忆模型" disabled={isRunning || modelDisabled || catalog.length === 0}
          onClick={event => {
            if (open) { setOpen(false); return; }
            dismissSkillPanel();
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
                    <small>{modelFacts(model)}</small></span>
                  {model.isDefault && <span className="composer-model-default">默认</span>}
                  {model.ref === modelRef && <Check size={15} aria-hidden="true" />}
                </button>)}
              </div>;
            })}
            {!filtered.length && <p className="composer-model-empty">没有匹配的模型</p>}
          </div>
        </div>, document.body)}
        <div className="composer-file-controls">
          {!mobileInline && onSelectedSkillIdsChange && <button type="button" className="composer-skill-button" aria-label="技能"
            aria-expanded={skillOpen && skillMode === 'search'} disabled={isRunning || sendDisabled}
            onClick={() => {
              if (skillOpen && skillMode === 'search') {
                setSkillOpen(false);
                return;
              }
              setSkillMode('search');
              setSkillQuery('');
              placeSkillPopover();
              setSkillOpen(true);
              setOpen(false);
              setAddOpen(false);
            }}>技能</button>}
          <input ref={fileInputRef} className="composer-file-input" type="file" multiple
            aria-label="选择本地文件" disabled={attachmentsDisabled} onChange={event => onFileInput('file', event)} />
          <input ref={imageInputRef} className="composer-file-input" type="file" multiple accept={IMAGE_ACCEPT}
            aria-label="选择图片" disabled={attachmentsDisabled} onChange={event => onFileInput('image', event)} />
          <button type="button" className="composer-add-button" aria-label="添加附件" title="添加附件"
            aria-haspopup="menu" aria-expanded={addOpen} disabled={attachmentsDisabled}
            onClick={event => {
              if (addOpen) { setAddOpen(false); return; }
              dismissSkillPanel();
              const rect = event.currentTarget.getBoundingClientRect();
              setAddPosition({ top: Math.max(8, rect.top - (mobileInline ? 188 : 140)), left: Math.min(rect.left, window.innerWidth - 180) });
              setAddOpen(true); setOpen(false);
            }}><Plus size={18} aria-hidden="true" /></button>
          {addOpen && createPortal(<div className="composer-add-menu" role="menu" aria-label="添加附件"
            style={addPosition}>
            {mobileInline && onSelectedSkillIdsChange && <button type="button" role="menuitem"
              onClick={() => { setAddOpen(false); setSkillMode('search'); setSkillQuery(''); setSkillOpen(true); setOpen(false); }}>选择技能</button>}
            <button type="button" role="menuitem" onClick={() => pickFiles('file')}>上传文件</button>
            <button type="button" role="menuitem" onClick={() => { setAddOpen(false); onChooseWorkspaceFiles?.(); }}>
              选择工作区文件</button>
            <button type="button" role="menuitem" onClick={() => pickFiles('image')}>添加图片</button>
            {mobileInline && <button type="button" role="menuitem" disabled={modelDisabled || catalog.length === 0}
              onClick={() => {
                setAddOpen(false); setQuery('');
                setPosition({ top: Math.max(8, addPosition.top - 270), left: 8,
                  width: Math.min(360, window.innerWidth - 16) });
                setOpen(true);
              }}>切换模型</button>}
            {mobileInline && <button type="button" role="menuitem" disabled={financeSaving || isRunning}
              onClick={() => { setAddOpen(false); setFinanceOpen(true); }}>财经数据</button>}
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
        onClick={closePreview}>关闭</button>
      <img src={preview.url} alt={preview.name} />
    </div>, document.body)}
  </Composer>
  {onSelectedSkillIdsChange && mobileInline && skillOpen && createPortal(<div className="skill-picker-backdrop" onPointerDown={dismissSkillPanel} />, document.body)}
  {onSelectedSkillIdsChange && createPortal(<div className={`skill-picker-popover${mobileInline ? ' is-mobile' : ''}`} hidden={!skillOpen}
    role={mobileInline && skillOpen ? 'dialog' : undefined} aria-label={mobileInline && skillOpen ? '选择技能' : undefined}
    aria-modal={mobileInline && skillOpen ? true : undefined}
    style={skillOpen && !mobileInline ? {
      left: skillPosition.left,
      width: skillPosition.width,
      maxHeight: skillPosition.maxHeight,
      ...(skillPosition.top == null
        ? { top: 'auto', bottom: skillPosition.bottom }
        : { top: skillPosition.top, bottom: 'auto' }),
    } : undefined}>
    <SkillPicker ref={pickerRef} value={selectedSkillIds ?? []} disabled={isRunning || sendDisabled}
      scopeKey={skillScopeKey} preserveMissing={preserveMissingSkills} open={skillOpen} query={skillQuery}
      inputMode={skillMode} onQueryChange={setSkillQuery} onRequestClose={dismissSkillPanel}
      onPicked={applyPickedSkill} onCatalogChange={setSkillCatalog} onPhaseChange={setSkillPhase}
      onChange={onSelectedSkillIdsChange} />
  </div>, document.body)}
  </div>;
}
