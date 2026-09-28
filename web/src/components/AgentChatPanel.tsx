import { useChat, type MastraDBMessage } from '@mastra/react';
import { ChatShell } from '@mastra/playground-ui/components/ChatShell';
import {
  Composer,
  ComposerActions,
  ComposerBox,
  ComposerInput,
} from '@mastra/playground-ui/components/Composer';
import { isToolPart, readToolPart } from '@mastra/playground-ui/domains/chat';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { AGENT_ID, RESOURCE_ID } from '../constants';

const SUGGESTED_PROMPTS = [
  '这周末奥斯汀天气怎么样？',
  'SPCX 股价现在是多少？',
  '做一个日式樱花节落地页。',
];

type ApprovalEntry = {
  toolCallId: string;
  toolName?: string;
};

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const item = part as { type?: string; text?: string };
    return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
  }).join('');
}

function messageText(message: MastraDBMessage): string {
  const content = message.content as { parts?: unknown; content?: unknown };
  return textFromParts(content.parts) || textFromParts(content.content);
}

function pendingApprovalFromMessages(messages: MastraDBMessage[]): ApprovalEntry | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entries = approvalEntries(messages[index]);
    if (entries.length > 0) return entries[entries.length - 1];
    const parts = messages[index].content?.parts ?? [];
    for (const part of parts) {
      if (!isToolPart(part)) continue;
      const tool = readToolPart(part);
      if (tool.toolCallId) return { toolCallId: tool.toolCallId, toolName: tool.toolName };
    }
  }
  return undefined;
}

function messageShowsApproval(message: MastraDBMessage): boolean {
  const parts = message.content?.parts ?? [];
  const approvals = approvalEntries(message);
  if (approvals.some((entry) => !parts.some((part) => (
    isToolPart(part) && readToolPart(part).toolCallId === entry.toolCallId
  )))) {
    return true;
  }
  return parts.some((part) => {
    if (!isToolPart(part)) return false;
    const tool = readToolPart(part);
    return approvals.some((entry) => entry.toolCallId === tool.toolCallId);
  });
}

function approvalEntries(message: MastraDBMessage): ApprovalEntry[] {
  const metadata = message.content?.metadata as {
    requireApprovalMetadata?: Record<string, ApprovalEntry>;
    pendingToolApprovals?: Record<string, ApprovalEntry>;
    suspendedTools?: Record<string, ApprovalEntry>;
  } | undefined;
  const entries: ApprovalEntry[] = [];
  for (const source of [
    metadata?.requireApprovalMetadata,
    metadata?.pendingToolApprovals,
    metadata?.suspendedTools,
  ]) {
    if (!source) continue;
    for (const entry of Object.values(source)) {
      if (entry?.toolCallId) entries.push(entry);
    }
  }
  return entries;
}

function MessageRow({
  message,
  onApprove,
  onDecline,
}: {
  message: MastraDBMessage;
  onApprove(toolCallId: string): void;
  onDecline(toolCallId: string): void;
}) {
  const parts = message.content?.parts ?? [];
  const approvals = approvalEntries(message);
  const toolParts = parts.filter((part) => isToolPart(part));

  return (
    <div
      className={message.role === 'user' ? 'message message--user' : 'message message--assistant'}
      data-role={message.role}
    >
      {messageText(message) ? <p>{messageText(message)}</p> : null}
      {toolParts.map((part) => {
        const tool = readToolPart(part);
        const needsApproval = approvals.some((entry) => entry.toolCallId === tool.toolCallId);
        return (
          <section className="tool-card" key={tool.toolCallId || tool.toolName}>
            <strong>{tool.toolName || '工具调用'}</strong>
            {needsApproval ? (
              <div className="tool-actions">
                <button type="button" onClick={() => onApprove(tool.toolCallId)}>批准</button>
                <button type="button" onClick={() => onDecline(tool.toolCallId)}>拒绝</button>
              </div>
            ) : null}
          </section>
        );
      })}
      {approvals
        .filter((entry) => !toolParts.some((part) => readToolPart(part).toolCallId === entry.toolCallId))
        .map((entry) => (
          <section className="tool-card" key={entry.toolCallId}>
            <strong>{entry.toolName || '工具调用'}</strong>
            <div className="tool-actions">
              <button type="button" onClick={() => onApprove(entry.toolCallId)}>批准</button>
              <button type="button" onClick={() => onDecline(entry.toolCallId)}>拒绝</button>
            </div>
          </section>
        ))}
    </div>
  );
}

export function AgentChatPanel({
  threadId,
  onTitleSeed,
  ensureThread,
}: {
  threadId?: string;
  onTitleSeed?: (text: string) => void;
  ensureThread?: (firstMessage: string) => Promise<string>;
}) {
  const {
    messages,
    sendMessage,
    isRunning,
    cancelRun,
    approveToolCall,
    declineToolCall,
    isAwaitingToolApproval,
  } = useChat({ agentId: AGENT_ID, resourceId: RESOURCE_ID, threadId });

  const [draft, setDraft] = useState('');
  const showWelcome = !threadId && messages.length === 0;
  const fallbackApproval = isAwaitingToolApproval && !messages.some(messageShowsApproval)
    ? pendingApprovalFromMessages(messages)
    : undefined;

  async function handleSend(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;

    let targetThreadId = threadId;
    if (!targetThreadId) {
      onTitleSeed?.(trimmed);
      if (ensureThread) {
        targetThreadId = await ensureThread(trimmed);
      }
    }

    await sendMessage({
      message: trimmed,
      mode: 'stream',
      ...(targetThreadId ? { threadId: targetThreadId } : {}),
    });
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || isRunning) return;
    setDraft('');
    void handleSend(text);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <ChatShell className="h-full min-h-0 flex-1">
      <ChatShell.Stage>
        <ChatShell.Viewport>
          <ChatShell.Content>
            <ChatShell.Column className="gap-4 py-6">
              {showWelcome ? (
                <div className="welcome-panel">
                  <h1 className="welcome">想从哪里开始？</h1>
                  <div className="suggested-prompts">
                    {SUGGESTED_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        className="suggested-prompt"
                        onClick={() => void handleSend(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  onApprove={(toolCallId) => void approveToolCall(toolCallId)}
                  onDecline={(toolCallId) => void declineToolCall(toolCallId)}
                />
              ))}
              {fallbackApproval ? (
                <div className="message message--assistant" data-role="assistant">
                  <section className="tool-card">
                    <strong>{fallbackApproval.toolName || '工具调用'}</strong>
                    <div className="tool-actions">
                      <button type="button" onClick={() => void approveToolCall(fallbackApproval.toolCallId)}>
                        批准
                      </button>
                      <button type="button" onClick={() => void declineToolCall(fallbackApproval.toolCallId)}>
                        拒绝
                      </button>
                    </div>
                  </section>
                </div>
              ) : null}
            </ChatShell.Column>
          </ChatShell.Content>
        </ChatShell.Viewport>
      </ChatShell.Stage>
      <ChatShell.Dock>
        <ChatShell.Column>
          <Composer onSubmit={submit}>
            <ComposerBox sendingPulseKey={isRunning ? 1 : 0}>
              <ComposerInput
                aria-label="消息"
                placeholder="输入消息…"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isRunning && !isAwaitingToolApproval}
              />
              <ComposerActions>
                {isRunning ? (
                  <button type="button" onClick={() => cancelRun()}>停止</button>
                ) : (
                  <button type="submit" disabled={!draft.trim()}>发送</button>
                )}
              </ComposerActions>
            </ComposerBox>
          </Composer>
        </ChatShell.Column>
      </ChatShell.Dock>
    </ChatShell>
  );
}
