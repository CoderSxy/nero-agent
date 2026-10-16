import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type { OmMarkerData } from '@mastra/playground-ui/domains/chat/tools/badges/observation-marker-badge';
import { stripAttachmentProtocol } from './attachment-protocol';
import { isUserMessage } from './pending-user-message';

export type ToolPart = { id: string; name: string; args: unknown; result?: unknown; state: string };
type ObservationState = 'running' | 'complete' | 'failed' | 'buffering' | 'buffering-complete' |
  'buffering-failed' | 'activated';
export type DisplayPart = { kind: 'text'; text: string } |
  { kind: 'reasoning'; text: string; streaming: boolean; redacted: boolean } |
  { kind: 'observation'; state: ObservationState; cycleId?: string; data: OmMarkerData } |
  { kind: 'tool'; tool: ToolPart };

const omStates: Record<string, ObservationState> = {
  'data-om-observation-start': 'running',
  'data-om-observation-end': 'complete',
  'data-om-observation-failed': 'failed',
  'data-om-buffering-start': 'buffering',
  'data-om-buffering-end': 'buffering-complete',
  'data-om-buffering-failed': 'buffering-failed',
  'data-om-activation': 'activated',
};

function readableObservations(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const content = (value.match(/<observations>\s*([\s\S]*?)\s*<\/observations>/i)?.[1] ?? value).trim();
  if (!content || content.toLowerCase() === 'no observations') return undefined;
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.some(line => /^\*\s*\S/.test(line))) return value;
  if (!lines.some(line => !/^(?:Date:|Thread [a-f0-9]+:)/i.test(line))) return undefined;
  return lines.map(line => /^(?:Date:|Thread [a-f0-9]+:)/i.test(line) ? line
    : `* ${line.replace(/^[-*]\s*/, '')}`).join('\n');
}

export {
  buildAgentAttachmentMessage,
  DEFAULT_ATTACHMENT_PROMPT,
  parseAttachmentIdsFromText,
  stripAttachmentProtocol,
  userVisibleText,
} from './attachment-protocol';

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
  const settledCycles = new Set(parts.filter(part => part.type === 'data-om-observation-end' ||
    part.type === 'data-om-observation-failed' || part.type === 'data-om-buffering-end' ||
    part.type === 'data-om-buffering-failed')
    .map(part => (part as typeof part & { data?: { cycleId?: string } }).data?.cycleId)
    .filter((id): id is string => typeof id === 'string'));
  const items: DisplayPart[] = parts.flatMap<DisplayPart>(part => {
    if (part.type === 'text' && 'text' in part) {
      const text = isUserMessage(message) ? stripAttachmentProtocol(part.text) : part.text;
      return text ? [{ kind: 'text', text }] : [];
    }
    if (part.type === 'reasoning') {
      const reasoning = part as typeof part & { reasoning?: string; text?: string; state?: string; redacted?: boolean };
      const text = reasoning.text ?? reasoning.reasoning ?? '';
      return text || reasoning.redacted || reasoning.state === 'streaming'
        ? [{ kind: 'reasoning', text, streaming: reasoning.state === 'streaming', redacted: reasoning.redacted === true }]
        : [];
    }
    const omState = omStates[part.type];
    if (omState) {
      const data = ((part as typeof part & { data?: OmMarkerData }).data ?? {}) as OmMarkerData;
      if ((omState === 'running' || omState === 'buffering') && data.cycleId && settledCycles.has(data.cycleId)) return [];
      const observations = (omState === 'buffering-complete' || omState === 'complete' || omState === 'activated')
        ? readableObservations(data.observations) : data.observations;
      return [{ kind: 'observation', state: omState, cycleId: data.cycleId,
        data: { ...data, observations, _state: omState === 'running' ? 'loading' : omState } }];
    }
    if (part.type === 'tool-invocation' && 'toolInvocation' in part) {
      const invocation = part.toolInvocation;
      return [{ kind: 'tool', tool: { id: invocation.toolCallId, name: invocation.toolName, args: invocation.args,
        result: 'result' in invocation ? invocation.result : undefined, state: invocation.state } }];
    }
    return [];
  });
  if (!items.length && typeof content.content === 'string') items.push({ kind: 'text', text: content.content });
  // A generated turn can persist its final text before the process markers are
  // appended. Keep earlier text/tool steps in place, but show the trailing
  // process before the final answer.
  if (message.role === 'assistant') {
    let finalTextIndex = -1;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index].kind === 'text') { finalTextIndex = index; break; }
    }
    const trailing = items.slice(finalTextIndex + 1);
    if (finalTextIndex >= 0 && trailing.some(item => item.kind === 'reasoning' || item.kind === 'observation')) {
      return [...items.slice(0, finalTextIndex), ...trailing, items[finalTextIndex]];
    }
  }
  return items;
}

export function summarize(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); }
}
