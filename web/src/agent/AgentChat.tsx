import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { useChat } from '@mastra/react';
import { ChatShell } from '@mastra/playground-ui/components/ChatShell';
import { AGENT_ID, listWorkspaceFiles } from './client';
import { uploadWorkspaceFile } from './attachment-client';
import { MAX_UPLOAD_BYTES, type ComposerAttachment } from './attachment-types';
import { AgentComposer } from './AgentComposer';
import { MessageList } from './MessageList';
import { createModelRequestContext, type ModelSettings } from './model-settings';
import type { ModelRef, SafeModel } from './model-catalog-client';
import { nextPendingUserMessage, withPendingUserMessages, type PendingUserMessage } from './pending-user-message';
import { WorkspaceFilePicker } from './WorkspaceFilePicker';

type PendingUpload = { key: string; file: File };

export function AgentChat({ title = '未命名会话', threadId, resourceId, initialMessages, onMessageSent, models, catalog = [],
  onModelChange, modelRef, modelDisabled = false, modelError, sendBlockedReason,
  pendingUserMessages = [], onMessageSubmitted, onMessageFailed, onFilesChanged }: {
  title?: string; threadId: string; resourceId: string; initialMessages: MastraDBMessage[];
  onMessageSent: (message: PendingUserMessage) => void;
  models: ModelSettings | null; catalog?: SafeModel[]; modelRef?: ModelRef;
  onModelChange?: (ref: ModelRef) => void; modelDisabled?: boolean; modelError?: string | null;
  sendBlockedReason?: string | null;
  pendingUserMessages?: PendingUserMessage[];
  onMessageSubmitted?: (message: PendingUserMessage) => void;
  onMessageFailed?: (message: PendingUserMessage) => void;
  onFilesChanged?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedDecisions, setFailedDecisions] = useState<Set<string>>(new Set());
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pendingUploads = useRef(new Map<string, PendingUpload>());
  const nextAttachmentId = useRef(0);
  const viewportId = useId();
  const followRef = useRef(true);
  const chatModel = models?.chatModel;
  const memoryModel = models?.memoryModel;
  const requestContext = useMemo(() => chatModel && memoryModel
    ? createModelRequestContext({ chatModel, memoryModel }) : undefined, [chatModel, memoryModel]);
  const blockedReason = sendBlockedReason ?? (models ? null : '请先配置可用模型');
  const chat = useChat({ agentId: AGENT_ID, resourceId, threadId, initialMessages, requestContext,
    enableThreadSignals: true });
  const wasRunning = useRef(chat.isRunning);
  useEffect(() => {
    if (wasRunning.current && !chat.isRunning) onFilesChanged?.();
    wasRunning.current = chat.isRunning;
  }, [chat.isRunning, onFilesChanged]);
  const visibleMessages = withPendingUserMessages(chat.messages, pendingUserMessages);
  const isEmpty = !hasSubmitted && initialMessages.length === 0 && visibleMessages.length === 0;
  useLayoutEffect(() => {
    const viewport = document.getElementById(viewportId);
    if (viewport && followRef.current) viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  }, [viewportId, visibleMessages]);
  useEffect(() => {
    const viewport = document.getElementById(viewportId);
    const content = viewport?.querySelector('[data-slot="message-scroller-content"]');
    if (!viewport || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [viewportId]);

  function nextKey() {
    return `att-${++nextAttachmentId.current}`;
  }

  function oversizeMessage(name: string) {
    return `文件超过 10 MiB 上限：${name}`;
  }

  function reconcileComposerError(attachments: ComposerAttachment[]) {
    if (!attachments.some(item => item.state === 'failed')) setError(null);
  }

  function addOversizeAttachment(file: File) {
    const key = nextKey();
    const error = oversizeMessage(file.name);
    setAttachments(current => [...current, {
      key, source: 'personal', path: '', name: file.name, size: file.size,
      mimeType: file.type || 'application/octet-stream', etag: '', state: 'failed', error,
    }]);
  }

  async function startUpload(file: File, key = nextKey()) {
    pendingUploads.current.set(key, { key, file });
    setAttachments(current => {
      const existing = current.find(item => item.key === key);
      if (existing) {
        return current.map(item => item.key === key
          ? { ...item, state: 'uploading', error: undefined } : item);
      }
      return [...current, {
        key, source: 'personal', path: '', name: file.name, size: file.size,
        mimeType: file.type || 'application/octet-stream', etag: '', state: 'uploading',
      }];
    });
    try {
      const result = await uploadWorkspaceFile(file);
      setAttachments(current => {
        const next = current.map(item => item.key === key ? {
          ...item,
          source: result.source,
          path: result.path,
          name: result.name,
          size: result.size,
          mimeType: result.mimeType,
          etag: result.etag,
          state: 'ready',
          error: undefined,
        } : item);
        reconcileComposerError(next);
        return next;
      });
      pendingUploads.current.delete(key);
      onFilesChanged?.();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '上传失败';
      setAttachments(current => current.map(item => item.key === key
        ? { ...item, state: 'failed', error: message } : item));
      setError(message);
    }
  }

  function uploadFiles(files: File[], kind: 'file' | 'image') {
    const accepted = kind === 'image'
      ? files.filter(file => /^image\/(png|jpeg|webp|gif)$/i.test(file.type)
        || /\.(png|jpe?g|webp|gif)$/i.test(file.name))
      : files;
    if (!accepted.length) {
      setError(kind === 'image' ? '仅支持 PNG、JPEG、WebP、GIF 图片' : '未选择有效文件');
      return;
    }
    for (const file of accepted) {
      if (file.size > MAX_UPLOAD_BYTES) {
        addOversizeAttachment(file);
        continue;
      }
      void startUpload(file);
    }
  }

  function retryAttachment(key: string) {
    const pending = pendingUploads.current.get(key);
    if (!pending) return;
    void startUpload(pending.file, key);
  }

  function removeAttachment(key: string) {
    pendingUploads.current.delete(key);
    setAttachments(current => {
      const next = current.filter(item => item.key !== key);
      reconcileComposerError(next);
      return next;
    });
  }

  async function chooseWorkspaceFiles(paths: string[]) {
    if (!paths.length) return;
    try {
      const { files } = await listWorkspaceFiles('personal');
      const byPath = new Map(files.filter(file => file.type === 'file').map(file => [file.path, file]));
      const seen = new Set<string>();
      const candidates: ComposerAttachment[] = [];
      for (const path of paths) {
        const identity = `personal:${path}`;
        if (seen.has(identity)) continue;
        const entry = byPath.get(path);
        if (!entry) continue;
        seen.add(identity);
        candidates.push({
          key: nextKey(),
          source: 'personal',
          path,
          name: path.split('/').at(-1) ?? path,
          size: entry.size,
          mimeType: guessMime(path),
          etag: '',
          state: 'ready',
        });
      }
      setAttachments(current => {
        const existing = new Set(current.map(item => `${item.source}:${item.path}`));
        const additions = candidates.filter(item => {
          const identity = `${item.source}:${item.path}`;
          if (existing.has(identity)) return false;
          existing.add(identity);
          return true;
        });
        const next = [...current, ...additions];
        reconcileComposerError(next);
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载工作区文件失败');
    }
  }

  async function send() {
    const message = draft.trim();
    if (!message || blockedReason || modelDisabled || chat.isRunning || chat.isAwaitingToolApproval) return;
    if (attachments.some(item => item.state !== 'ready')) return;
    const pending = nextPendingUserMessage(message, chat.messages, pendingUserMessages);
    onMessageSubmitted?.(pending);
    setHasSubmitted(true); setDraft(''); setError(null);
    try { await chat.sendMessage({ message, mode: 'stream', threadId,
      requestContext,
      onChunk: async chunk => {
        if (chunk.type === 'tool-call-approval') {
          const id = chunk.payload?.toolCallId;
          if (typeof id === 'string') setPendingApprovalIds(value => new Set(value).add(id));
        }
      },
    }); onMessageSent(pending); }
    catch (cause) { onMessageFailed?.(pending);
      setError(cause instanceof Error ? cause.message : '请求失败'); }
  }
  async function approve(id: string) {
    try { await chat.approveToolCall(id); setError(null);
      setPendingApprovalIds(value => { const next = new Set(value); next.delete(id); return next; });
      setFailedDecisions(value => { const next = new Set(value); next.delete(id); return next; }); }
    catch (cause) { setFailedDecisions(value => new Set(value).add(id)); setError(cause instanceof Error ? cause.message : '批准失败'); throw cause; }
  }
  async function decline(id: string) {
    try { await chat.declineToolCall(id); setError(null);
      setPendingApprovalIds(value => { const next = new Set(value); next.delete(id); return next; });
      setFailedDecisions(value => { const next = new Set(value); next.delete(id); return next; }); }
    catch (cause) { setFailedDecisions(value => new Set(value).add(id)); setError(cause instanceof Error ? cause.message : '拒绝失败'); throw cause; }
  }
  async function answer(id: string, value: string | string[]) {
    try { await chat.approveToolCall(id, value); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '提交回答失败'); throw cause; }
  }
  const visibleApprovals = Object.fromEntries(Object.entries(chat.toolCallApprovals)
    .filter(([id]) => !failedDecisions.has(id)));
  return <ChatShell className={`chat-shell ${isEmpty ? 'chat-shell--empty' : 'chat-shell--active'}`}>
    <ChatShell.Bar><div className="chat-title text-label" title={title}>{title}</div></ChatShell.Bar>
    <ChatShell.Stage><ChatShell.Viewport id={viewportId} onScroll={event => {
      const viewport = event.currentTarget;
      followRef.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 48;
    }}><ChatShell.Content><ChatShell.Column>
      <MessageList messages={visibleMessages} isRunning={chat.isRunning} error={error}
        approvals={visibleApprovals} pendingApprovalIds={pendingApprovalIds}
        onApprove={approve} onDecline={decline} onAnswer={answer} />
    </ChatShell.Column></ChatShell.Content></ChatShell.Viewport></ChatShell.Stage>
    <ChatShell.Dock><ChatShell.Column>
      <div className="chat-welcome" aria-hidden={!isEmpty}>
        <span className="chat-welcome-icon" aria-hidden="true">智</span>
        <h1>有什么可以帮你？</h1>
      </div>
      {blockedReason && <p className="notice" role="status">{blockedReason}</p>}
      {modelError && <p className="error" role="alert">{modelError}</p>}
      <AgentComposer draft={draft} sendDisabled={Boolean(blockedReason) || modelDisabled} onDraftChange={setDraft}
      catalog={catalog} modelRef={modelRef ?? models?.chatModel} onModelChange={onModelChange} modelDisabled={modelDisabled}
      isRunning={chat.isRunning || chat.isAwaitingToolApproval} onSend={() => void send()}
      attachments={attachments}
      onChooseWorkspaceFiles={() => setPickerOpen(true)}
      onUploadFiles={uploadFiles}
      onRemoveAttachment={removeAttachment}
      onRetryAttachment={retryAttachment}
      onStop={() => { chat.cancelRun(); setError('已停止'); }} />
      {pickerOpen && <WorkspaceFilePicker source="personal"
        onConfirm={paths => void chooseWorkspaceFiles(paths)}
        onClose={() => setPickerOpen(false)} />}
    </ChatShell.Column></ChatShell.Dock>
  </ChatShell>;
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
