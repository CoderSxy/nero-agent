import { describe, expect, it } from 'vitest';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { emptyHistoryState, mergeHistoryWindow, mergeLiveMessages } from './history-window-state';
import type { HistoryWindow } from './history-window-types';

function msg(id: string, createdAt: string): MastraDBMessage {
  return {
    id,
    role: 'user',
    createdAt: new Date(createdAt),
    content: { format: 2, parts: [{ type: 'text', text: id }] },
  };
}

function window(partial: Partial<HistoryWindow> & Pick<HistoryWindow, 'messages'>): HistoryWindow {
  return {
    version: 1,
    thread: { id: 't', resourceId: 'u', updatedAt: '2026-10-01T00:00:00.000Z' },
    turns: partial.messages.map((message) => ({
      turnId: message.id,
      originMessageId: message.id,
      provisional: false,
      messageIds: [message.id],
      partialBefore: false,
      partialAfter: false,
    })),
    previousCursor: null,
    nextCursor: null,
    snapshotUpper: 'upper',
    oversizedMessage: false,
    ...partial,
  };
}

describe('history-window-state', () => {
  it('dedupes prepend/append by id and merges provisional aliases', () => {
    const current = mergeHistoryWindow(
      emptyHistoryState(),
      window({
        messages: [msg('m2', '2026-10-01T00:00:02.000Z'), msg('m3', '2026-10-01T00:00:03.000Z')],
        turns: [{
          turnId: 'partial:upper:m3',
          originMessageId: null,
          provisional: true,
          messageIds: ['m2', 'm3'],
          partialBefore: true,
          partialAfter: false,
        }],
      }),
      'replace',
    );
    const prepended = mergeHistoryWindow(
      current,
      window({
        messages: [msg('m1', '2026-10-01T00:00:01.000Z'), msg('m2', '2026-10-01T00:00:02.000Z')],
        turns: [{
          turnId: 'm1',
          originMessageId: 'm1',
          provisional: false,
          replacesTurnIds: ['partial:upper:m3'],
          messageIds: ['m1', 'm2', 'm3'],
          partialBefore: false,
          partialAfter: false,
        }],
        previousCursor: null,
        nextCursor: 'next',
      }),
      'prepend',
    );
    expect(prepended.messages.map((message) => message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(prepended.turnAliases['partial:upper:m3']).toBe('m1');
  });

  it('marks a gap when around and later latest cannot join', () => {
    const around = mergeHistoryWindow(
      { ...emptyHistoryState('around'), mode: 'around', snapshotUpper: 'old' },
      window({
        messages: [msg('early', '2026-09-01T00:00:00.000Z')],
        snapshotUpper: 'old',
        nextCursor: 'gap-cursor',
      }),
      'replace',
    );
    around.mode = 'around';
    around.snapshotUpper = 'old';
    const withGap = mergeHistoryWindow(
      around,
      window({
        messages: [msg('late', '2026-10-01T00:00:00.000Z')],
        snapshotUpper: 'new',
        previousCursor: null,
      }),
      'append',
    );
    expect(withGap.gap).toBe(true);
  });

  it('mergeLive does not change snapshot upper', () => {
    const current = mergeHistoryWindow(
      emptyHistoryState(),
      window({ messages: [msg('m1', '2026-10-01T00:00:01.000Z')], snapshotUpper: 'frozen' }),
      'replace',
    );
    const next = mergeLiveMessages(current, [msg('m2', '2026-10-01T00:00:02.000Z')]);
    expect(next.snapshotUpper).toBe('frozen');
    expect(next.messages.map((message) => message.id)).toEqual(['m1', 'm2']);
  });
});
