import type { MastraDBMessage } from '@mastra/core/agent/message-list';
function parts(message: MastraDBMessage): any[] {
  return typeof message.content === 'string' ? [{type:'text',text:message.content}] : message.content.parts ?? [];
}
function tailText(message: MastraDBMessage): string {
  return [...parts(message)].reverse().find(p => p.type === 'text')?.text ?? '';
}
function calls(messages: MastraDBMessage[]): string[] {
  return messages.flatMap(m => parts(m).filter(p => p.type === 'tool-invocation').map(p => p.toolInvocation.toolCallId));
}
export function hasRepeatedToolIds(messages: MastraDBMessage[]): boolean {
  const ids = calls(messages); return new Set(ids).size !== ids.length;
}
/** Only accept a settled snapshot once it covers every live identity and final text. */
export function historyCoversLive(history: MastraDBMessage[], live: MastraDBMessage[]): boolean {
  const byId = new Map(history.map(m => [m.id,m]));
  const storedCalls = new Set(calls(history));
  return live.every(m => {
    const stored = byId.get(m.id);
    return stored && stored.role === m.role && tailText(stored) === tailText(m);
  }) && calls(live).every(id => storedCalls.has(id));
}
export function reconcileChatMessages({history,live,settled}: {history:MastraDBMessage[];live:MastraDBMessage[];settled:boolean}): MastraDBMessage[] {
  if (!settled || !historyCoversLive(history,live)) return live;
  const liveById = new Map(live.map(m => [m.id,m]));
  return history.map(message => {
    const current = liveById.get(message.id);
    if (!current || typeof message.content === 'string') return message;
    // OM and application markers may arrive after text has persisted. Keep them,
    // but never append the cumulative text/reasoning/tool snapshot to history.
    const stored = parts(message);
    const key = (p:any) => `${p.type}:${p.data?.cycleId ?? p.data?.runId ?? ''}`;
    const custom = new Map(stored.filter(p=>p.type.startsWith('data-')).map(p=>[key(p),p]));
    for(const p of parts(current)) if(p.type.startsWith('data-')) custom.set(key(p),p);
    const next = [...stored.filter(p=>!p.type.startsWith('data-')), ...custom.values()];
    return {...message,content:{...message.content,parts:next}};
  });
}
