import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHistoryWindow, normalizeHistoryWindow } from './history-window-client';
import * as client from './client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('history-window-client', () => {
  it('encodes query params and uses apiFetch', async () => {
    const apiFetch = vi.spyOn(client, 'apiFetch').mockResolvedValue(
      new Response(JSON.stringify({
        version: 1,
        thread: { id: 't1', resourceId: 'u1', updatedAt: '2026-10-01T00:00:00.000Z' },
        messages: [{ id: 'm1', role: 'user', createdAt: '2026-10-01T00:00:00.000Z',
          content: { format: 2, parts: [{ type: 'text', text: 'hi' }] } }],
        turns: [{ turnId: 'm1', originMessageId: 'm1', provisional: false, messageIds: ['m1'],
          partialBefore: false, partialAfter: false }],
        previousCursor: null,
        nextCursor: null,
        snapshotUpper: 'cursor',
        oversizedMessage: false,
      }), { status: 200 }),
    );
    const window = await fetchHistoryWindow('thread 1', { before: 'a/b', around: undefined });
    expect(apiFetch).toHaveBeenCalledOnce();
    const [path, init] = apiFetch.mock.calls[0]!;
    expect(path).toContain('/agent-history/threads/thread%201/window');
    expect(path).toContain('before=a%2Fb');
    expect(init?.signal).toBeUndefined();
    expect(window.messages[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('rejects non-2xx and damaged payloads', async () => {
    vi.spyOn(client, 'apiFetch').mockResolvedValue(
      new Response(JSON.stringify({ error: '无权访问该会话' }), { status: 403 }),
    );
    await expect(fetchHistoryWindow('t')).rejects.toMatchObject({ status: 403 });

    expect(() => normalizeHistoryWindow([{ id: 'raw-array' }])).toThrow(/版本|无效/);
    expect(() => normalizeHistoryWindow({ version: 1, thread: { id: 't', resourceId: 'u' }, messages: 'nope', turns: [] }))
      .toThrow(/messages/);
  });

  it('honors AbortSignal', async () => {
    const controller = new AbortController();
    vi.spyOn(client, 'apiFetch').mockImplementation(async (_path, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(fetchHistoryWindow('t', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
