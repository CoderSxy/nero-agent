import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type { OmMarkerData } from '@mastra/playground-ui/domains/chat/tools/badges/observation-marker-badge';

export type ToolPart = { id: string; name: string; args: unknown; result?: unknown; state: string };
export type DisplayPart = { kind: 'text'; text: string } |
  { kind: 'reasoning'; text: string; streaming: boolean; redacted: boolean } |
  { kind: 'observation'; state: 'running' | 'complete'; cycleId?: string; data: OmMarkerData } |
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
  const completedCycles = new Set(parts.filter(part => part.type === 'data-om-observation-end')
    .map(part => (part as typeof part & { data?: { cycleId?: string } }).data?.cycleId)
    .filter((id): id is string => typeof id === 'string'));
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
      const data = ((part as typeof part & { data?: OmMarkerData }).data ?? {}) as OmMarkerData;
      if (part.type === 'data-om-observation-start' && data.cycleId && completedCycles.has(data.cycleId)) return [];
      const complete = part.type === 'data-om-observation-end';
      return [{ kind: 'observation', state: complete ? 'complete' : 'running', cycleId: data.cycleId,
        data: { ...data, _state: complete ? 'complete' : 'loading' } }];
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
