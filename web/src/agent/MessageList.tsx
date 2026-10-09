import { useEffect, useRef, useState } from 'react';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { Message } from '@mastra/playground-ui/components/Message';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { ToolCall, ToolCallTrigger, ToolCallHeader, ToolCallContent, ToolCallMono } from '@mastra/playground-ui/components/ai/tool-call';
import { ToolApproval } from '@mastra/playground-ui/components/ai/tool-approval';
import { AskUser } from '@mastra/playground-ui/components/ai/ask-user';
import { ObservationMarkerBadge } from '@mastra/playground-ui/domains/chat/tools/badges/observation-marker-badge';
import { Globe2, Wrench, Terminal, LoaderCircle } from 'lucide-react';
import type { PreparedAttachment } from './attachment-client';
import { formatBytes, isImageAttachment } from './attachment-types';
import { parseAttachmentIdsFromText } from './attachment-protocol';
import { fetchWorkspaceFile } from './client';
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

function toolPresentation(name: string) {
  if (/search|browse/i.test(name)) return { label: 'Search the web', Icon: Globe2 };
  if (/fetch/i.test(name)) return { label: 'Web fetch', Icon: Wrench };
  if (/execute|command|shell/i.test(name)) return { label: 'Run command', Icon: Terminal };
  return { label: name.replaceAll('_', ' '), Icon: Wrench };
}

function toolDetail(name: string, args: unknown) {
  const input = record(args);
  const value = /search|browse/i.test(name) ? input?.query ?? input?.searchQuery :
    /fetch/i.test(name) ? input?.url : undefined;
  return typeof value === 'string' ? value : null;
}

function rawUserText(message: MastraDBMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts.filter(part => part.type === 'text').map(part => 'text' in part ? part.text : '').join('');
}

function attachmentsForMessage(message: MastraDBMessage, threadAttachments: PreparedAttachment[]): PreparedAttachment[] {
  if (!threadAttachments.length || !isUserMessage(message)) return [];
  // Durable join: attachment IDs embedded in agent text survive reload.
  // @mastra/react may rename message.id to client-set-* and strip metadata.clientMessageId.
  const ids = new Set(parseAttachmentIdsFromText(rawUserText(message)));
  if (ids.size) {
    const byText = threadAttachments.filter(item => ids.has(item.attachmentId));
    if (byText.length) return byText;
  }
  // Optimistic / pending bubbles still match prepare's clientMessageId.
  const byId = threadAttachments.filter(item => item.clientMessageId === message.id);
  if (byId.length) return byId;
  const metadataId = record(message.content.metadata)?.clientMessageId;
  if (typeof metadataId === 'string') {
    const byMeta = threadAttachments.filter(item => item.clientMessageId === metadataId);
    if (byMeta.length) return byMeta;
  }
  return [];
}

function HistoryAttachmentCard({ attachment }: { attachment: PreparedAttachment }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const unavailable = attachment.status === 'deleted' || attachment.status === 'changed';
  const isImage = !unavailable && isImageAttachment(attachment) && attachment.path;

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

  const statusLabel = attachment.status === 'deleted' ? '文件已删除'
    : attachment.status === 'changed' ? '文件已更新' : formatBytes(attachment.size);

  return <div className={`message-attachment-card${unavailable ? ' is-unavailable' : ''}`}
    aria-label={`附件 ${attachment.name}`} title={attachment.path}>
    {isImage && thumbUrl ? <div className="message-attachment-thumb">
      <img src={thumbUrl} alt={attachment.name} />
    </div> : <div className="message-attachment-meta">
      <strong>{attachment.name}</strong>
      <small className={unavailable ? 'message-attachment-status' : undefined}>{statusLabel}</small>
    </div>}
  </div>;
}

export function MessageList({ messages, isRunning, error, onApprove, onDecline, onAnswer, approvals = {},
  pendingApprovalIds, threadAttachments = [] }: {
  messages: MastraDBMessage[]; isRunning: boolean; error: string | null;
  onApprove: (id: string) => Promise<void>; onDecline: (id: string) => Promise<void>;
  onAnswer: (id: string, answer: string | string[]) => Promise<void>;
  approvals?: Record<string, { status: 'approved' | 'declined' }>;
  pendingApprovalIds?: ReadonlySet<string>;
  threadAttachments?: PreparedAttachment[];
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
  const rows = messages.map(message => ({
    message,
    parts: messageParts(message),
    attachments: attachmentsForMessage(message, threadAttachments),
  }));
  const completedCycles = new Set<string>();
  for (const { parts } of rows) {
    for (const part of parts) {
      if (part.kind === 'observation' && part.state === 'complete' && part.cycleId) {
        completedCycles.add(part.cycleId);
      }
    }
  }
  return <div className="message-list" aria-live="polite">
    {rows.map(({ message, parts: rawParts, attachments }) => {
      const parts = rawParts.filter(part => part.kind !== 'observation' || part.state !== 'running' ||
        !part.cycleId || !completedCycles.has(part.cycleId));
      if (!parts.length && !attachments.length) return null;
      const runningProcess = isRunning && message === messages.at(-1) &&
        parts.some(part => part.kind === 'reasoning' || part.kind === 'tool' || part.kind === 'observation');
      return <Message key={message.id} from={isUserMessage(message) ? 'user' : 'assistant'}
        className={runningProcess ? 'process-message process-message--running' : undefined}>
        {attachments.length > 0 && <div className="message-attachment-row" aria-label="消息附件">
          {attachments.map(item => <HistoryAttachmentCard key={item.attachmentId} attachment={item} />)}
        </div>}
        {parts.map((part, index) => {
          if (part.kind === 'observation') return <ObservationMarkerBadge key={part.cycleId ?? index}
            toolName={part.state === 'running' ? 'Observing' : 'Observed'} args={{}}
            metadata={{ omData: part.data }} />;
          if (part.kind === 'reasoning') return <details key={index} className="process-reasoning" open>
            <summary className={part.streaming ? 'process-reasoning__streaming' : undefined}>Reasoning</summary>
            <div className="process-reasoning__content">
              <MarkdownRenderer streaming={part.streaming}>{part.redacted ? 'Reasoning was redacted by the provider.' : part.text}</MarkdownRenderer>
            </div>
          </details>;
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
          const { label, Icon } = toolPresentation(tool.name);
          const detail = toolDetail(tool.name, tool.args);
          const needsApproval = unresolved && (tool.state === 'approval-requested' ||
            !!interaction(message, 'requireApprovalMetadata', tool) || pendingApprovalIds?.has(tool.id));
          return <div key={`${tool.id}-${index}`} className="tool-row">
          <ToolCall defaultOpen={needsApproval} status={tool.state === 'call' && isRunning ? 'running' : 'idle'}>
            <ToolCallTrigger><ToolCallHeader><Icon size={16} aria-hidden="true" />
              <span>{label}</span>{detail && <span className="tool-detail">{detail}</span>}
              {tool.state === 'call' && isRunning && <LoaderCircle className="tool-progress" size={14} aria-hidden="true" />}
            </ToolCallHeader></ToolCallTrigger>
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
        {runningProcess && !parts.some(part => part.kind === 'observation' && part.state === 'running') &&
          <p className="process-status" role="status"><LoaderCircle size={14} aria-hidden="true" />正在处理…</p>}
      </Message>;
    })}
    {isRunning && !messages.some(message => message === messages.at(-1) && messageParts(message)
      .some(part => part.kind === 'reasoning' || part.kind === 'tool' || part.kind === 'observation')) &&
      <p className="run-status" role="status"><LoaderCircle size={14} aria-hidden="true" />正在回复…</p>}
    {error && <p role="alert" className="error">回复未完成：{error}</p>}
  </div>;
}
