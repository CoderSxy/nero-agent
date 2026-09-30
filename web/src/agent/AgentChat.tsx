import { useMemo, useState } from 'react';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { useChat } from '@mastra/react';
import { ChatShell } from '@mastra/playground-ui/components/ChatShell';
import { AGENT_ID } from './client';
import { AgentComposer } from './AgentComposer';
import { MessageList } from './MessageList';
import { createMemoryRequestContext, type ModelSettings } from './model-settings';

export function AgentChat({ threadId, resourceId, initialMessages, onMessageSent, models }: {
  threadId: string; resourceId: string; initialMessages: MastraDBMessage[]; onMessageSent: () => void;
  models: ModelSettings;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failedDecisions, setFailedDecisions] = useState<Set<string>>(new Set());
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(new Set());
  const requestContext = useMemo(() => createMemoryRequestContext(models.memoryModel), [models.memoryModel]);
  const chat = useChat({ agentId: AGENT_ID, resourceId, threadId, initialMessages, requestContext });
  async function send() {
    const message = draft.trim();
    if (!message || chat.isRunning || chat.isAwaitingToolApproval) return;
    setDraft(''); setError(null);
    try { await chat.sendMessage({ message, mode: 'stream', threadId,
      model: models.chatModel, requestContext,
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
  return <ChatShell className="chat-shell">
    <ChatShell.Bar><div className="chat-title">智能体对话</div></ChatShell.Bar>
    <ChatShell.Stage><ChatShell.Viewport><ChatShell.Content><ChatShell.Column>
      <MessageList messages={chat.messages} isRunning={chat.isRunning} error={error}
        approvals={visibleApprovals} pendingApprovalIds={pendingApprovalIds}
        awaitingApproval={chat.isAwaitingToolApproval} onApprove={approve} onDecline={decline} />
    </ChatShell.Column></ChatShell.Content></ChatShell.Viewport></ChatShell.Stage>
    <ChatShell.Dock><ChatShell.Column><AgentComposer draft={draft} onDraftChange={setDraft}
      isRunning={chat.isRunning || chat.isAwaitingToolApproval} onSend={() => void send()}
      onStop={() => { chat.cancelRun(); setError('已停止'); }} />
    </ChatShell.Column></ChatShell.Dock>
  </ChatShell>;
}
