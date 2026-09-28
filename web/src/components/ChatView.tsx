import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AssistantTurn, ToolCard } from '../lib/stream-reducer';

type HistoryItem = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  tools?: ToolCard[];
};

type ChatViewProps = {
  mode: 'new' | 'thread';
  userMessages: Array<{ id: string; text: string }>;
  assistant: AssistantTurn | null;
  history: HistoryItem[];
  pending: boolean;
  banner?: string;
  onSend(text: string): void;
  onStop(): void;
  onApprove(toolCallId: string): void;
  onDecline(toolCallId: string): void;
  onRetry(): void;
};

function JsonValue({ value }: { value: unknown }) {
  if (value === undefined) return null;
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return <pre>{text}</pre>;
}

function ToolCards({
  tools = [],
  onApprove,
  onDecline,
}: {
  tools?: ToolCard[];
  onApprove(toolCallId: string): void;
  onDecline(toolCallId: string): void;
}) {
  return tools.map((tool) => (
    <section className="tool-card" key={tool.toolCallId}>
      <strong>{tool.toolName || '工具调用'}</strong>
      <JsonValue value={tool.args} />
      <JsonValue value={tool.result} />
      {tool.error ? <p className="tool-error">{tool.error}</p> : null}
      {tool.approval === 'pending' ? (
        <div className="tool-actions">
          <button type="button" onClick={() => onApprove(tool.toolCallId)}>批准</button>
          <button type="button" onClick={() => onDecline(tool.toolCallId)}>拒绝</button>
        </div>
      ) : null}
    </section>
  ));
}

function AssistantContent({
  text,
  reasoning,
  tools,
  onApprove,
  onDecline,
}: {
  text: string;
  reasoning?: string;
  tools?: ToolCard[];
  onApprove(toolCallId: string): void;
  onDecline(toolCallId: string): void;
}) {
  return (
    <div className="message message--assistant">
      {reasoning ? (
        <details className="reasoning">
          <summary>思考过程</summary>
          <p>{reasoning}</p>
        </details>
      ) : null}
      {text ? <p>{text}</p> : null}
      <ToolCards tools={tools} onApprove={onApprove} onDecline={onDecline} />
    </div>
  );
}

export function ChatView({
  mode,
  userMessages,
  assistant,
  history,
  pending,
  banner,
  onSend,
  onStop,
  onApprove,
  onDecline,
  onRetry,
}: ChatViewProps) {
  const [draft, setDraft] = useState('');
  const hasMessages = history.length > 0 || userMessages.length > 0 || assistant !== null;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || pending) return;
    setDraft('');
    onSend(text);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <main className="chat-view">
      {banner ? (
        <div className="banner" role="alert">
          <span>{banner}</span>
          <button type="button" onClick={onRetry}>重试</button>
        </div>
      ) : null}
      <div className="messages">
        {!hasMessages && mode === 'new' ? <h1 className="welcome">想从哪里开始？</h1> : null}
        {history.map((item) => item.role === 'user' ? (
          <div className="message message--user" key={item.id}><p>{item.text}</p></div>
        ) : (
          <AssistantContent
            key={item.id}
            text={item.text}
            reasoning={item.reasoning}
            tools={item.tools}
            onApprove={onApprove}
            onDecline={onDecline}
          />
        ))}
        {userMessages.map((message) => (
          <div className="message message--user" key={message.id}><p>{message.text}</p></div>
        ))}
        {assistant ? (
          <AssistantContent
            text={assistant.text}
            reasoning={assistant.reasoning}
            tools={assistant.tools}
            onApprove={onApprove}
            onDecline={onDecline}
          />
        ) : null}
      </div>
      <form className="composer" onSubmit={submit}>
        <textarea
          aria-label="消息"
          placeholder="输入消息…"
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {pending ? (
          <button className="send-button" type="button" onClick={onStop}>停止</button>
        ) : (
          <button className="send-button" type="submit" disabled={!draft.trim()}>发送</button>
        )}
      </form>
    </main>
  );
}
