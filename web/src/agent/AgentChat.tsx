import { useMemo, useState } from 'react';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { useChat } from '@mastra/react';
import { ChatShell } from '@mastra/playground-ui/components/ChatShell';
import { AGENT_ID } from './client';
import { AgentComposer } from './AgentComposer';
import { MessageList } from './MessageList';
import { createModelRequestContext, type ModelSettings } from './model-settings';
import type { ModelRef, SafeModel } from './model-catalog-client';

export function AgentChat({ threadId, resourceId, initialMessages, onMessageSent, models, catalog = [],
  onModelChange, modelRef, modelDisabled = false, modelError, sendBlockedReason }: {
  threadId: string; resourceId: string; initialMessages: MastraDBMessage[]; onMessageSent: () => void;
  models: ModelSettings | null; catalog?: SafeModel[]; modelRef?: ModelRef;
  onModelChange?: (ref: ModelRef) => void; modelDisabled?: boolean; modelError?: string | null;
  sendBlockedReason?: string | null;
}) {
  const [draft, setDraft] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedDecisions, setFailedDecisions] = useState<Set<string>>(new Set());
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(new Set());
  const chatModel = models?.chatModel;
  const memoryModel = models?.memoryModel;
  const requestContext = useMemo(() => chatModel && memoryModel
    ? createModelRequestContext({ chatModel, memoryModel }) : undefined, [chatModel, memoryModel]);
  const blockedReason = sendBlockedReason ?? (models ? null : '请先配置可用模型');
  const chat = useChat({ agentId: AGENT_ID, resourceId, threadId, initialMessages, requestContext });
  const isEmpty = !hasSubmitted && initialMessages.length === 0 && chat.messages.length === 0;
  async function send() {
    const message = draft.trim();
    if (!message || blockedReason || modelDisabled || chat.isRunning || chat.isAwaitingToolApproval) return;
    setHasSubmitted(true); setDraft(''); setError(null);
    try { await chat.sendMessage({ message, mode: 'stream', threadId,
      requestContext,
      onChunk: async chunk => {
        if (chunk.type === 'tool-call-approval' || chunk.type === 'tool-call-suspended') {
          const id = chunk.payload?.toolCallId;
          if (typeof id === 'string') setPendingApprovalIds(value => new Set(value).add(id));
        }
      },
    }); onMessageSent(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '请求失败'); }
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
  const visibleApprovals = Object.fromEntries(Object.entries(chat.toolCallApprovals)
    .filter(([id]) => !failedDecisions.has(id)));
  return <ChatShell className={`chat-shell ${isEmpty ? 'chat-shell--empty' : 'chat-shell--active'}`}>
    <ChatShell.Bar><div className="chat-title">智能体对话</div></ChatShell.Bar>
    <ChatShell.Stage><ChatShell.Viewport><ChatShell.Content><ChatShell.Column>
      <MessageList messages={chat.messages} isRunning={chat.isRunning} error={error}
        approvals={visibleApprovals} pendingApprovalIds={pendingApprovalIds}
        awaitingApproval={chat.isAwaitingToolApproval} onApprove={approve} onDecline={decline} />
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
      onStop={() => { chat.cancelRun(); setError('已停止'); }} />
    </ChatShell.Column></ChatShell.Dock>
  </ChatShell>;
}
