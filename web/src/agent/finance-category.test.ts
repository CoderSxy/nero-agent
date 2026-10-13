import { describe, expect, it } from 'vitest';
import { readThreadFinanceCategory, saveThreadFinanceCategory, withThreadFinanceCategory } from './finance-category';

describe('per-thread finance category', () => {
  it('keeps unrelated metadata and removes only the finance field', () => {
    const initial = { neroAgentModels: { chatModel: 'model-a' }, title: 'A' };
    const selected = withThreadFinanceCategory(initial, 'fund');
    expect(readThreadFinanceCategory(selected)).toBe('fund');
    expect(withThreadFinanceCategory(selected, null)).toEqual(initial);
    expect(readThreadFinanceCategory({ neroAgentFinanceCategory: 'unknown' })).toBeNull();
  });
  it('checks ownership and serializes writes for one thread', async () => {
    let metadata: Record<string, unknown> = { neroAgentModels: { chatModel: 'model-a' } };
    const thread = { get: async () => ({ resourceId: 'user-a', metadata }),
      update: async ({ metadata: next }: { metadata: Record<string, unknown> }) => { metadata = next; } };
    await Promise.all([
      saveThreadFinanceCategory('thread-a', thread, 'fund', 'user-a'),
      saveThreadFinanceCategory('thread-a', thread, 'index', 'user-a'),
    ]);
    expect(metadata).toEqual({ neroAgentModels: { chatModel: 'model-a' }, neroAgentFinanceCategory: 'index' });
    await expect(saveThreadFinanceCategory('thread-a', thread, 'all', 'user-b')).rejects.toThrow(/无权访问/);
  });
});
