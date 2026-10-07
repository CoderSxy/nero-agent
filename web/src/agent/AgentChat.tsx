import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { useChat } from '@mastra/react';
import { ChatShell } from '@mastra/playground-ui/components/ChatShell';
import { AGENT_ID, fetchUserFile, uploadUserFile } from './client';
import { AgentComposer } from './AgentComposer';
import { MessageList } from './MessageList';
import { createModelRequestContext, type ModelSettings } from './model-settings';
import type { ModelRef, SafeModel } from './model-catalog-client';
import { nextPendingUserMessage, withPendingUserMessages, type PendingUserMessage } from './pending-user-message';

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
  const [attachments, setAttachments] = useState<Array<{ id: number; name: string; path?: string }>>([]);
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
  function chooseFile(file: File) {
    const id = ++nextAttachmentId.current;
    setAttachments(current => [...current, { id, name: file.name }]);
    void uploadUserFile(threadId, file.name, file).then(result => {
      setAttachments(current => current.map(item => item.id === id ? { ...item, path: result.path } : item));
      onFilesChanged?.();
      setError(null);
    }).catch(cause => {
      setAttachments(current => current.filter(item => item.id !== id));
      setError(cause instanceof Error ? cause.message : '上传失败');
    });
  }
  function downloadFile(path: string) {
    void fetchUserFile(threadId, path).then(blob => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = path.split('/').at(-1) ?? 'download';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }).catch(cause => setError(cause instanceof Error ? cause.message : '下载失败'));
  }
  async function send() {
    const message = draft.trim();
    if (!message || blockedReason || modelDisabled || chat.isRunning || chat.isAwaitingToolApproval) return;
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
      attachments={attachments} onChooseFile={chooseFile} onDownloadFile={downloadFile}
      onStop={() => { chat.cancelRun(); setError('已停止'); }} />
    </ChatShell.Column></ChatShell.Dock>
  </ChatShell>;
}
