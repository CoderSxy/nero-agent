import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type { OmMarkerData } from '@mastra/playground-ui/domains/chat/tools/badges/observation-marker-badge';
import { stripAttachmentProtocol } from './attachment-protocol';
import { isUserMessage } from './pending-user-message';

export type ToolPart = { id: string; name: string; args: unknown; result?: unknown; state: string };
type ObservationState = 'running' | 'complete' | 'failed' | 'buffering' | 'buffering-complete' |
  'buffering-failed' | 'activated';
export type DisplayPart = { kind: 'text'; text: string } |
  { kind: 'delivery-error'; reason: string; message: string } |
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
  const chartProtocol = parts.some(part => part.type === 'data-nero-chart' && (part as any).data?.version === 2);
  const settledCycles = new Set(parts.filter(part => part.type === 'data-om-observation-end' ||
    part.type === 'data-om-observation-failed' || part.type === 'data-om-buffering-end' ||
    part.type === 'data-om-buffering-failed')
    .map(part => (part as typeof part & { data?: { cycleId?: string } }).data?.cycleId)
    .filter((id): id is string => typeof id === 'string'));
  const items: DisplayPart[] = parts.flatMap<DisplayPart>(part => {
    if (part.type === 'data-nero-chart') {
      const data = (part as any).data;
      return data?.status === 'ready' && typeof data.markdown === 'string' ? [{ kind: 'text', text: data.markdown }] : [];
    }
    if (part.type === 'data-nero-delivery') {
      const data = (part as any).data;
      return data?.version === 2 && data.status === 'failed' ? [{ kind: 'delivery-error', reason: data.reason, message: data.message ?? '图表未生成：模型未返回符合协议的数据。' }] : [];
    }
    if (part.type === 'text' && 'text' in part) {
      if (chartProtocol && message.role === 'assistant') return [];
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
  if (!items.length && !chartProtocol && typeof content.content === 'string') items.push({ kind: 'text', text: content.content });
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

export type SkillActivationView = {
  serverExecutionId: string;
  skillId: string;
  name: string;
  version?: number;
  manifestHash?: string;
  hashPrefix?: string;
  status: 'loaded' | 'failed';
  errorCode?: string;
};

const SKILL_ACTIVATION_PART = 'data-nero-skill-activation';
const SKILL_TOOL_NAMES = new Set(['skill', 'skill_read', 'skill_search', 'run_skill_script']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function skillHashPrefix(hash: unknown): string | undefined {
  if (typeof hash !== 'string' || !/^[a-f0-9]{8,64}$/i.test(hash)) return undefined;
  return hash.slice(0, 8).toLowerCase();
}

function safeSkillName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || /^\/Users\/|^\/home\/|^[A-Za-z]:\\/.test(trimmed)) return null;
  return trimmed;
}

function viewFromActivation(raw: unknown): SkillActivationView | null {
  if (!isRecord(raw)) return null;
  if (raw.status !== 'loaded' && raw.status !== 'failed') return null;
  if (typeof raw.skillId !== 'string' || !raw.skillId.trim()) return null;
  if (typeof raw.name !== 'string') return null;
  const name = safeSkillName(raw.name);
  if (!name) return null;
  const manifestHash = typeof raw.manifestHash === 'string' ? raw.manifestHash : undefined;
  return {
    serverExecutionId: typeof raw.serverExecutionId === 'string' ? raw.serverExecutionId : '',
    skillId: raw.skillId,
    name,
    version: typeof raw.version === 'number' ? raw.version : undefined,
    manifestHash,
    hashPrefix: skillHashPrefix(manifestHash),
    status: raw.status,
    errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : undefined,
  };
}

function viewFromTool(name: string, args: unknown, result: unknown): SkillActivationView | null {
  if (!SKILL_TOOL_NAMES.has(name) || !isRecord(result) || typeof result.ok !== 'boolean') return null;
  const skill = isRecord(result.skill) ? result.skill : {};
  const input = isRecord(args) ? args : {};
  if (result.ok) {
    return viewFromActivation({
      serverExecutionId: '',
      skillId: skill.skillId,
      name: skill.name,
      version: skill.version,
      manifestHash: skill.manifestHash,
      status: 'loaded',
    });
  }
  const skillId = typeof skill.skillId === 'string' ? skill.skillId
    : typeof input.skillId === 'string' ? input.skillId
      : typeof input.name === 'string' ? input.name : '';
  const label = typeof skill.name === 'string' ? skill.name
    : typeof input.name === 'string' ? input.name : skillId;
  return viewFromActivation({
    serverExecutionId: '',
    skillId,
    name: label,
    version: skill.version,
    manifestHash: skill.manifestHash,
    status: 'failed',
    errorCode: result.code,
  });
}

function dedupeActivations(items: SkillActivationView[]): SkillActivationView[] {
  const exact = new Map<string, SkillActivationView>();
  for (const item of items) {
    const key = [item.serverExecutionId, item.skillId, item.version ?? '', item.status].join('/');
    if (!exact.has(key)) exact.set(key, item);
  }
  const list = [...exact.values()];
  const identified = list.filter(item => item.serverExecutionId);
  return list.filter(item => {
    if (item.serverExecutionId) return true;
    return !identified.some(other => other.skillId === item.skillId
      && other.version === item.version && other.status === item.status);
  });
}

/** Badges come from tool results, activation chunks, and saved metadata — never from composer chips. */
export function skillActivations(message: MastraDBMessage): SkillActivationView[] {
  const content = message.content;
  if (typeof content === 'string' || !content) return [];
  const found: SkillActivationView[] = [];
  const parts = Array.isArray(content.parts) ? content.parts : [];
  for (const part of parts) {
    if (part.type === SKILL_ACTIVATION_PART) {
      const data = (part as { data?: unknown }).data;
      const view = viewFromActivation(data);
      if (view) found.push(view);
      continue;
    }
    if (part.type === 'tool-invocation' && 'toolInvocation' in part) {
      const invocation = part.toolInvocation;
      const view = viewFromTool(
        invocation.toolName,
        invocation.args,
        'result' in invocation ? invocation.result : undefined,
      );
      if (view) found.push(view);
    }
  }
  const metadata = isRecord(content.metadata) ? content.metadata : null;
  const saved = metadata?.neroSkillActivations;
  if (Array.isArray(saved)) {
    for (const item of saved) {
      const view = viewFromActivation(item);
      if (view) found.push(view);
    }
  }
  return dedupeActivations(found);
}
