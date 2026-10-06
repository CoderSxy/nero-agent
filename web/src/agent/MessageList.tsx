import { useRef, useState } from 'react';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { Message } from '@mastra/playground-ui/components/Message';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { ToolCall, ToolCallTrigger, ToolCallHeader, ToolCallContent, ToolCallMono } from '@mastra/playground-ui/components/ai/tool-call';
import { ToolApproval } from '@mastra/playground-ui/components/ai/tool-approval';
import { AskUser } from '@mastra/playground-ui/components/ai/ask-user';
import { messageParts, streamError, summarize, type ToolPart } from './message-parts';
import { isUserMessage } from './pending-user-message';

type AskUserPayload = { question: string; options?: { label: string; description?: string }[];
  selectionMode?: 'single_select' | 'multi_select' };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function interaction(message: MastraDBMessage, key: 'suspendedTools' | 'requireApprovalMetadata', tool: ToolPart) {
  const entries = record(record(message.content.metadata)?.[key]);
  const named = record(entries?.[tool.name]);
  if (named?.toolCallId === tool.id) return named;
  const byId = record(entries?.[tool.id]);
  return byId?.toolCallId === tool.id ? byId : null;
}

function askUserPayload(value: unknown): AskUserPayload | null {
  const input = record(value);
  if (typeof input?.question !== 'string' || !input.question.trim()) return null;
  const options = input.options;
  if (options !== undefined && (!Array.isArray(options) || !options.every(option =>
    typeof record(option)?.label === 'string' &&
    (record(option)?.description === undefined || typeof record(option)?.description === 'string')))) return null;
  const selectionMode = input.selectionMode;
  if (selectionMode !== undefined && selectionMode !== 'single_select' && selectionMode !== 'multi_select') return null;
  return { question: input.question, ...(options === undefined ? {} : { options }),
    ...(selectionMode === undefined ? {} : { selectionMode }) } as AskUserPayload;
}

function settled(state: string) {
  return state === 'result' || state === 'output-available' || state === 'output-error' || state === 'output-denied';
}

export function MessageList({ messages, isRunning, error, onApprove, onDecline, onAnswer, approvals = {},
  pendingApprovalIds }: {
  messages: MastraDBMessage[]; isRunning: boolean; error: string | null;
  onApprove: (id: string) => Promise<void>; onDecline: (id: string) => Promise<void>;
  onAnswer: (id: string, answer: string | string[]) => Promise<void>;
  approvals?: Record<string, { status: 'approved' | 'declined' }>;
  pendingApprovalIds?: ReadonlySet<string>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const busy = useRef(new Set<string>());
  async function decide(id: string, action: 'approve' | 'decline') {
    if (busy.current.has(id) || approvals[id]) return;
    busy.current.add(id); setPending(id);
    try { await (action === 'approve' ? onApprove(id) : onDecline(id)); }
    catch { /* AgentChat presents the API error; leave the decision available. */ }
    finally { busy.current.delete(id); setPending(null); }
  }
  async function answer(id: string, value: string | string[]) {
    if (busy.current.has(id) || approvals[id]) return;
    busy.current.add(id); setPending(id);
    try { await onAnswer(id, value); }
    catch { /* AgentChat shows the error; keep the question available. */ }
    finally { busy.current.delete(id); setPending(null); }
  }
  return <div className="message-list" aria-live="polite">
    {messages.map(message => {
      const parts = messageParts(message);
      return <Message key={message.id} from={isUserMessage(message) ? 'user' : 'assistant'}>
        {parts.map((part, index) => {
          if (part.kind === 'text') {
            const errorText = message.role === 'assistant' ? streamError(part.text) : null;
            return errorText ? <p key={index} role="alert" className="error">回复未完成：{errorText}</p> :
              <MarkdownRenderer key={index} streaming={isRunning && message === messages.at(-1)}>{part.text}</MarkdownRenderer>;
          }
          const tool = part.tool;
          const suspension = interaction(message, 'suspendedTools', tool);
          const payload = tool.name === 'ask_user'
            ? askUserPayload(suspension?.suspendPayload ?? (settled(tool.state) ? tool.args : undefined)) : null;
          if (payload) {
            const result = record(tool.result);
            const output = typeof result?.content === 'string'
              ? { content: result.content, isError: result.isError === true } : undefined;
            return <AskUser key={`${tool.id}-${index}`} payload={payload} result={output}
              isAnswered={approvals[tool.id]?.status === 'approved'} isSubmitting={pending === tool.id}
              onSubmit={value => void answer(tool.id, value)} />;
          }
          const unresolved = !settled(tool.state);
          const needsApproval = unresolved && (tool.state === 'approval-requested' ||
            !!interaction(message, 'requireApprovalMetadata', tool) || pendingApprovalIds?.has(tool.id));
          return <div key={`${tool.id}-${index}`} className="tool-row">
          <ToolCall defaultOpen={tool.state !== 'result'} status={tool.state === 'call' && isRunning ? 'running' : 'idle'}>
            <ToolCallTrigger><ToolCallHeader>{tool.name}</ToolCallHeader></ToolCallTrigger>
            <ToolCallContent><ToolCallMono copyText={summarize(tool.args)}>{summarize(tool.args)}</ToolCallMono>
              {tool.result !== undefined && <ToolCallMono copyText={summarize(tool.result)}>{summarize(tool.result)}</ToolCallMono>}
            </ToolCallContent>
          </ToolCall>
          {tool.state === 'output-denied' && <p className="muted">已拒绝执行</p>}
          {suspension && unresolved && !needsApproval && <p className="muted" role="status">工具已暂停，等待后续输入</p>}
          {needsApproval && <ToolApproval toolName={tool.name}
            status={approvals[tool.id]?.status} disabled={pending === tool.id || !!approvals[tool.id]}
            onApprove={() => void decide(tool.id, 'approve')} onDecline={() => void decide(tool.id, 'decline')}>
            <span className="muted">{summarize(tool.args)}</span>
          </ToolApproval>}
          </div>;
        })}
      </Message>;
    })}
    {isRunning && <p className="run-status">正在回复…</p>}
    {error && <p role="alert" className="error">回复未完成：{error}</p>}
  </div>;
}
