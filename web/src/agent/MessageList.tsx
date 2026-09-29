import { useRef, useState } from 'react';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { Message } from '@mastra/playground-ui/components/Message';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { ToolCall, ToolCallTrigger, ToolCallHeader, ToolCallContent, ToolCallMono } from '@mastra/playground-ui/components/ai/tool-call';
import { ToolApproval } from '@mastra/playground-ui/components/ai/tool-approval';
import { messageParts, streamError, summarize } from './message-parts';

export function MessageList({ messages, isRunning, error, onApprove, onDecline, approvals = {}, pendingApprovalIds,
  awaitingApproval = false }: {
  messages: MastraDBMessage[]; isRunning: boolean; error: string | null;
  onApprove: (id: string) => Promise<void>; onDecline: (id: string) => Promise<void>;
  approvals?: Record<string, { status: 'approved' | 'declined' }>;
  pendingApprovalIds?: ReadonlySet<string>; awaitingApproval?: boolean;
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
  const latestUnresolvedCall = messages.flatMap(message => messageParts(message))
    .filter(part => part.kind === 'tool' && part.tool.state === 'call').at(-1);
  const latestUnresolvedId = latestUnresolvedCall?.kind === 'tool' ? latestUnresolvedCall.tool.id : null;
  return <div className="message-list" aria-live="polite">
    {messages.map(message => {
      const parts = messageParts(message);
      return <Message key={message.id} from={message.role === 'user' ? 'user' : 'assistant'}>
        {parts.map((part, index) => {
          if (part.kind === 'text') {
            const errorText = message.role === 'assistant' ? streamError(part.text) : null;
            return errorText ? <p key={index} role="alert" className="error">回复未完成：{errorText}</p> :
              <MarkdownRenderer key={index} streaming={isRunning && message === messages.at(-1)}>{part.text}</MarkdownRenderer>;
          }
          const tool = part.tool;
          return <div key={`${tool.id}-${index}`} className="tool-row">
          <ToolCall defaultOpen={tool.state !== 'result'} status={tool.state === 'call' && isRunning ? 'running' : 'idle'}>
            <ToolCallTrigger><ToolCallHeader>{tool.name}</ToolCallHeader></ToolCallTrigger>
            <ToolCallContent><ToolCallMono copyText={summarize(tool.args)}>{summarize(tool.args)}</ToolCallMono>
              {tool.result !== undefined && <ToolCallMono copyText={summarize(tool.result)}>{summarize(tool.result)}</ToolCallMono>}
            </ToolCallContent>
          </ToolCall>
          {tool.state === 'output-denied' && <p className="muted">已拒绝执行</p>}
          {(tool.state === 'approval-requested' || pendingApprovalIds?.has(tool.id) ||
            (awaitingApproval && tool.id === latestUnresolvedId && !isRunning)) && <ToolApproval toolName={tool.name}
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
