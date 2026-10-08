import type { MastraDBMessage } from '@mastra/core/agent/message-list';

export type ToolPart = { id: string; name: string; args: unknown; result?: unknown; state: string };
export type DisplayPart = { kind: 'text'; text: string } |
  { kind: 'reasoning'; text: string; streaming: boolean; redacted: boolean } |
  { kind: 'observation'; state: 'running' | 'complete'; tokens?: number } |
  { kind: 'tool'; tool: ToolPart };
export function streamError(text: string): string | null {
  if (!text.trimStart().startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value.message === 'string' && (value.name === 'Error' || value.code)
      ? value.message : null;
  } catch { return null; }
}
export function messageParts(message: MastraDBMessage) {
  const content = message.content;
  if (typeof content === 'string') return [{ kind: 'text', text: content }] satisfies DisplayPart[];
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const items: DisplayPart[] = parts.flatMap<DisplayPart>(part => {
    if (part.type === 'text' && 'text' in part) return [{ kind: 'text', text: part.text }];
    if (part.type === 'reasoning') {
      const reasoning = part as typeof part & { reasoning?: string; text?: string; state?: string; redacted?: boolean };
      const text = reasoning.text ?? reasoning.reasoning ?? '';
      return text || reasoning.redacted || reasoning.state === 'streaming'
        ? [{ kind: 'reasoning', text, streaming: reasoning.state === 'streaming', redacted: reasoning.redacted === true }]
        : [];
    }
    if (part.type === 'data-om-observation-start' || part.type === 'data-om-observation-end') {
      const data = (part as typeof part & { data?: { cycleId?: string; tokensToObserve?: number; tokensObserved?: number } }).data;
      const tokens = part.type === 'data-om-observation-start' ? data?.tokensToObserve : data?.tokensObserved;
      const completed = part.type === 'data-om-observation-end' || parts.some(candidate =>
        candidate.type === 'data-om-observation-end' &&
        (candidate as typeof candidate & { data?: { cycleId?: string } }).data?.cycleId === data?.cycleId);
      return [{ kind: 'observation', state: completed ? 'complete' : 'running',
        ...(typeof tokens === 'number' ? { tokens } : {}) }];
    }
    if (part.type === 'tool-invocation' && 'toolInvocation' in part) {
      const invocation = part.toolInvocation;
      return [{ kind: 'tool', tool: { id: invocation.toolCallId, name: invocation.toolName, args: invocation.args,
        result: 'result' in invocation ? invocation.result : undefined, state: invocation.state } }];
    }
    return [];
  });
  if (!items.length && typeof content.content === 'string') items.push({ kind: 'text', text: content.content });
  return items;
}

export function summarize(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); }
}
