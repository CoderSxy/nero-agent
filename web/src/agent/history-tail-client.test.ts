import { expect, it, vi, afterEach } from 'vitest';
import { reconcileThreadTail } from './history-tail-client';
import * as client from './history-window-client';
const m = (id: string, role = 'assistant'): any => ({
  id,
  role,
  createdAt: new Date(({ u: 0, a: 1000, b: 2000 } as Record<string, number>)[id] ?? 3000),
  content: { format: 2, parts: [{ type: 'text', text: id }] },
});
const page = (messages: any[], nextCursor: string | null = null): any => ({ messages, nextCursor });
afterEach(() => vi.restoreAllMocks());
it('continues forward until a long live turn is covered', async () => {
  const live = [m('u', 'user'), m('a'), m('b')];
  const spy = vi
    .spyOn(client, 'fetchHistoryWindow')
    .mockResolvedValueOnce(page(live.slice(0, 2), 'after'))
    .mockResolvedValueOnce(page([live[2]]));
  expect(
    (await reconcileThreadTail({ threadId: 't', userId: 'u', liveMessages: live })).map((m) => m.id),
  ).toEqual(['u', 'a', 'b']);
  expect(spy.mock.calls[1]?.[1]?.after).toBe('after');
});
it('loads latest for a scheduled thread without any live messages', async () => {
  vi.spyOn(client, 'fetchHistoryWindow').mockResolvedValue(page([m('new')]));
  expect((await reconcileThreadTail({ threadId: 't', userId: 'u', liveMessages: [] })).length).toBe(1);
});
