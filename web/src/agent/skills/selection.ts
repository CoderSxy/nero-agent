import { RequestContext } from '@mastra/core/request-context';

export const SELECTED_SKILL_IDS_CONTEXT_KEY = 'nero-agent.selected-skill-ids';
export const SELECTED_SKILL_IDS_MAX = 5;

export function limitSkillIds(ids: string[]): string[] {
  const next: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || next.includes(id)) continue;
    next.push(id);
    if (next.length >= SELECTED_SKILL_IDS_MAX) break;
  }
  return next;
}

/** Copy the existing chat context and attach selected skill ids as intent only. */
export function mergeSkillSelection(base: RequestContext | undefined, skillIds: string[]): RequestContext {
  const next = new RequestContext();
  if (base) {
    for (const [key, value] of base.entries()) next.set(String(key), value);
  }
  const ids = limitSkillIds(skillIds);
  if (ids.length) next.set(SELECTED_SKILL_IDS_CONTEXT_KEY, ids);
  else next.delete(SELECTED_SKILL_IDS_CONTEXT_KEY);
  return next;
}
