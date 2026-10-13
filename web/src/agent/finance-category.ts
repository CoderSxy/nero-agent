import { updateOwnedThreadMetadata } from './thread-metadata-update';

export type FinanceCategory = 'all' | 'a_stock' | 'fund' | 'index' | 'macro' | 'futures';
export const financeCategoryOptions: readonly { value: FinanceCategory; label: string }[] = [
  { value: 'all', label: '全部' }, { value: 'a_stock', label: 'A 股' },
  { value: 'fund', label: '基金' }, { value: 'index', label: '指数' },
  { value: 'macro', label: '宏观' }, { value: 'futures', label: '期货' },
];
export const financeCategoryKey = 'neroAgentFinanceCategory';

export function readThreadFinanceCategory(metadata: unknown): FinanceCategory | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[financeCategoryKey];
  return financeCategoryOptions.some(option => option.value === value) ? value as FinanceCategory : null;
}

export function withThreadFinanceCategory(metadata: unknown, category: FinanceCategory | null): Record<string, unknown> {
  const current = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : {};
  const next = { ...current };
  if (category) next[financeCategoryKey] = category;
  else delete next[financeCategoryKey];
  return next;
}

export function saveThreadFinanceCategory(threadId: string, thread: Parameters<typeof updateOwnedThreadMetadata>[1],
  category: FinanceCategory | null, resourceId: string): Promise<Record<string, unknown>> {
  return updateOwnedThreadMetadata(threadId, thread, resourceId,
    metadata => withThreadFinanceCategory(metadata, category));
}
