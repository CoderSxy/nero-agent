import { useEffect, useRef, useState } from 'react';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { Message } from '@mastra/playground-ui/components/Message';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { RichMarkdownRenderer } from './markdown/markdown-renderer';
import { ToolCall, ToolCallTrigger, ToolCallHeader, ToolCallContent, ToolCallMono } from '@mastra/playground-ui/components/ai/tool-call';
import { ObservationMarkerBadge } from '@mastra/playground-ui/domains/chat/tools/badges/observation-marker-badge';
import { Copy, Globe2, Wrench, Terminal, LoaderCircle } from 'lucide-react';
import type { PreparedAttachment } from './attachment-client';
import { formatBytes, isImageAttachment } from './attachment-types';
import { parseAttachmentIdsFromText } from './attachment-protocol';
import { fetchWorkspaceFile } from './client';
import { messageParts, skillActivations, streamError, summarize, type ToolPart } from './message-parts';
import { SkillExecutionBadge } from './skills/SkillExecutionBadge';
import { ChineseAskUser, ChineseToolApproval } from './ChineseToolInteractions';
import { ChineseObservationComplete } from './ChineseObservationComplete';
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

const TOOL_LABELS: Record<string, string> = {
  search_web: '搜索网页', web_search: '搜索网页', tavily_search: '搜索网页',
  web_fetch: '读取网页', fetch_url: '读取网页',
  execute_command: '执行命令', run_command: '执行命令',
  read_file: '读取文件', write_file: '写入文件', edit_file: '编辑文件', edit: '编辑文件',
  glob: '查找文件', grep: '搜索内容', read_attached_file: '读取附件', list_files: '列出文件',
  task_write: '更新任务', ask_user: '询问用户', schedule_task: '创建定时任务',
};

function toolPresentation(name: string) {
  if (/search|browse/i.test(name)) return { label: '搜索网页', Icon: Globe2 };
  if (/fetch/i.test(name)) return { label: '读取网页', Icon: Wrench };
  if (/execute|command|shell/i.test(name)) return { label: '执行命令', Icon: Terminal };
  return { label: TOOL_LABELS[name] ?? name.replaceAll('_', ' '), Icon: Wrench };
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

function recordedModel(message: MastraDBMessage): string | null {
  const parts = message.content.parts;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.type === 'step-start' && typeof part.model === 'string' && part.model.trim()) return part.model;
  }
  return null;
}

function modelForAnswer(rows: readonly { message: MastraDBMessage }[], index: number): string | null {
  const ownModel = recordedModel(rows[index].message);
  if (ownModel) return ownModel;
  for (let previous = index - 1; previous >= 0 && rows[previous].message.role !== 'user'; previous -= 1) {
    const model = recordedModel(rows[previous].message);
    if (model) return model;
  }
  for (let next = index + 1; next < rows.length && rows[next].message.role !== 'user'; next += 1) {
    const model = recordedModel(rows[next].message);
    if (model) return model;
  }
  return null;
}

function formatMessageTime(date: Date, now = new Date()): string {
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === now.toDateString()) return time;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.floor((startOfToday - startOfDate) / 86400000);
  if (diffDays > 0 && diffDays < 7) {
    return `周${'日一二三四五六'[date.getDay()]} ${time}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function MessageActions({ message, text, model }: { message: MastraDBMessage; text: string; model: string | null }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const date = message.createdAt ? new Date(message.createdAt) : null;
  const time = date && !Number.isNaN(date.getTime())
    ? formatMessageTime(date) : null;
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopyStatus('copied'); }
    catch { setCopyStatus('error'); }
  }
  return <div className="message-actions" role="group" aria-label="回复操作">
    <button type="button" aria-label="复制消息" title="复制" onClick={() => void copy()}>
      <Copy size={14} aria-hidden="true" />
    </button>
    {copyStatus !== 'idle' && <span role="status" className={copyStatus === 'error' ? 'error' : undefined}>
      {copyStatus === 'copied' ? '已复制' : '复制失败'}
    </span>}
    {model && <span className="message-model-name" title={model}>{model}</span>}
    {time && <time className="message-time" dateTime={date!.toISOString()} title={date!.toLocaleString('zh-CN')}>
      {time}
    </time>}
  </div>;
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
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const busy = useRef(new Set<string>());
  async function decide(id: string, action: 'approve' | 'decline') {
    if (busy.current.has(id) || approvals[id]) return;
    busy.current.add(id); setPending(current => new Set(current).add(id));
    try { await (action === 'approve' ? onApprove(id) : onDecline(id)); }
    catch { /* AgentChat presents the API error; leave the decision available. */ }
    finally {
      busy.current.delete(id);
      setPending(current => { const next = new Set(current); next.delete(id); return next; });
    }
  }
  async function answer(id: string, value: string | string[]) {
    if (busy.current.has(id) || approvals[id]) return;
    busy.current.add(id); setPending(current => new Set(current).add(id));
    try { await onAnswer(id, value); }
    catch { /* AgentChat shows the error; keep the question available. */ }
    finally {
      busy.current.delete(id);
      setPending(current => { const next = new Set(current); next.delete(id); return next; });
    }
  }
  const rows = messages.map((message, sourceIndex) => ({
    message,
    sourceIndex,
    parts: messageParts(message),
    attachments: attachmentsForMessage(message, threadAttachments),
  }));
  let activeTurnStart = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUserMessage(messages[index])) { activeTurnStart = index; break; }
  }
  const orderedRows: typeof rows = [];
  for (const row of rows) {
    const processOnly = row.message.role === 'assistant' && row.attachments.length === 0 &&
      row.parts.length > 0 && row.parts.every(part => part.kind !== 'text') &&
      row.parts.some(part => part.kind === 'reasoning' || part.kind === 'observation');
    if (processOnly) {
      let insertAt = -1;
      for (let index = orderedRows.length - 1; index >= 0; index -= 1) {
        const prior = orderedRows[index];
        if (prior.message.role !== 'assistant') break;
        if (prior.parts.some(part => part.kind === 'text')) { insertAt = index; break; }
      }
      if (insertAt >= 0) { orderedRows.splice(insertAt, 0, row); continue; }
    }
    orderedRows.push(row);
  }
  const settledCycles = new Set<string>();
  for (const { parts } of orderedRows) {
    for (const part of parts) {
      if (part.kind === 'observation' && part.state !== 'running' && part.state !== 'buffering' && part.cycleId) {
        settledCycles.add(part.cycleId);
      }
    }
  }
  return <div className="message-list" aria-live="polite">
    {orderedRows.map(({ message, sourceIndex, parts: rawParts, attachments }, rowIndex) => {
      const parts = rawParts.filter(part => {
        if (part.kind !== 'observation') return true;
        if (part.state === 'running' || part.state === 'buffering') {
          return isRunning && sourceIndex >= activeTurnStart && (!part.cycleId || !settledCycles.has(part.cycleId));
        }
        if (part.state === 'buffering-complete') {
          const data = part.data;
          const extracted = Object.values(data.extractedValues ?? {}).some(value => value !== null && value !== undefined && value !== '');
          return Boolean(data.observations || extracted || data.extractionFailures?.length);
        }
        return true;
      });
      if (!parts.length && !attachments.length) return null;
      const runningProcess = isRunning && message === messages.at(-1) &&
        parts.some(part => part.kind === 'reasoning' || part.kind === 'tool' || part.kind === 'observation');
      const answerText = parts.filter(part => part.kind === 'text' && !streamError(part.text))
        .map(part => part.kind === 'text' ? part.text : '').join('\n\n').trim();
      return <Message key={message.id} from={isUserMessage(message) ? 'user' : 'assistant'}
        data-message-id={message.id}
        className={runningProcess ? 'process-message process-message--running' : undefined}>
        {message.role === 'assistant' && <SkillExecutionBadge activations={skillActivations(message)} />}
        {attachments.length > 0 && <div className="message-attachment-row" aria-label="消息附件">
          {attachments.map(item => <HistoryAttachmentCard key={item.attachmentId} attachment={item} />)}
        </div>}
        {parts.map((part, index) => {
          if (part.kind === 'observation') {
            const streamingObservation = part.state === 'running' || part.state === 'buffering';
            if (streamingObservation) {
              const om = record(part.data) ?? {};
              const count = typeof om.tokensToObserve === 'number' ? om.tokensToObserve
                : typeof om.tokensToBuffer === 'number' ? om.tokensToBuffer : null;
              const tokens = count === null ? '' : ` ~${(count / 1000).toFixed(1)}k tokens`;
              const label = om.operationType === 'reflection' ? '反思中' : '观察中';
              return <div key={part.cycleId ?? index} className="observation-pill" role="status"
                data-om-badge={part.cycleId ?? ''} data-om-state={part.state === 'buffering' ? 'buffering' : 'loading'}
                data-om-type={om.operationType === 'reflection' ? 'reflection' : 'observation'}>
                <LoaderCircle className="tool-progress" size={13} aria-hidden="true" />
                <span>{label}{tokens}</span>
              </div>;
            }
            if (part.state === 'complete' || part.state === 'buffering-complete' || part.state === 'activated') {
              return <ChineseObservationComplete key={part.cycleId ?? index} data={part.data} />;
            }
            return <ObservationMarkerBadge key={part.cycleId ?? index} toolName="已观察" args={{}}
              metadata={{ omData: part.data }} />;
          }
          if (part.kind === 'reasoning') return <details key={index} className="process-reasoning" open>
            <summary className={part.streaming ? 'process-reasoning__streaming' : undefined}>推理过程</summary>
            <div className="process-reasoning__content">
              <MarkdownRenderer streaming={part.streaming}>{part.redacted ? '提供方已隐去推理内容。' : part.text}</MarkdownRenderer>
            </div>
          </details>;
          if (part.kind === 'text') {
            const errorText = message.role === 'assistant' ? streamError(part.text) : null;
            return errorText ? <p key={index} role="alert" className="error">回复未完成：{errorText}</p> :
              <RichMarkdownRenderer key={index} streaming={isRunning && message === messages.at(-1)}>{part.text}</RichMarkdownRenderer>;
          }
          const tool = part.tool;
          const suspension = interaction(message, 'suspendedTools', tool);
          const payload = tool.name === 'ask_user'
            ? askUserPayload(suspension?.suspendPayload ?? (settled(tool.state) ? tool.args : undefined)) : null;
          if (payload) {
            const result = record(tool.result);
            const output = typeof result?.content === 'string'
              ? { content: result.content, isError: result.isError === true } : undefined;
            return <ChineseAskUser key={`${tool.id}-${index}`} payload={payload} result={output}
              isAnswered={approvals[tool.id]?.status === 'approved'} isSubmitting={pending.has(tool.id)}
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
          {needsApproval && <ChineseToolApproval toolName={label}
            status={approvals[tool.id]?.status} disabled={pending.has(tool.id) || !!approvals[tool.id]}
            onApprove={() => void decide(tool.id, 'approve')} onDecline={() => void decide(tool.id, 'decline')}>
            <span className="muted">{summarize(tool.args)}</span>
          </ChineseToolApproval>}
          </div>;
        })}
        {runningProcess && !parts.some(part => part.kind === 'observation' &&
          (part.state === 'running' || part.state === 'buffering')) &&
          <p className="process-status" role="status"><LoaderCircle size={14} aria-hidden="true" />正在处理…</p>}
        {message.role === 'assistant' && answerText && !(isRunning && message === messages.at(-1)) &&
          <MessageActions message={message} text={answerText} model={modelForAnswer(orderedRows, rowIndex)} />}
      </Message>;
    })}
    {isRunning && !messages.some(message => message === messages.at(-1) && messageParts(message)
      .some(part => part.kind === 'reasoning' || part.kind === 'tool' || part.kind === 'observation')) &&
      <p className="run-status" role="status"><LoaderCircle size={14} aria-hidden="true" />正在回复…</p>}
    {error && <p role="alert" className="error">回复未完成：{error}</p>}
  </div>;
}
