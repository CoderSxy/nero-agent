import { describe, expect, it } from 'vitest';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { nextPendingUserMessage, withPendingUserMessages } from './pending-user-message';

function message(id: string, role: 'user' | 'assistant', text: string, createdAt: string): MastraDBMessage {
  return { id, role, createdAt: new Date(createdAt), content: { format: 2, parts: [{ type: 'text', text }] } };
}

describe('pending user messages', () => {
  it('keeps a missing user message ahead of a streamed answer', () => {
    const pending = { id: 'local', text: '问题', occurrence: 1, createdAt: new Date('2026-10-06T01:00:00Z') };
    const answer = message('answer', 'assistant', '回答', '2026-10-06T01:00:01Z');
    expect(withPendingUserMessages([answer], [pending]).map(item => item.id)).toEqual(['local', 'answer']);
  });

  it('removes the fallback when the matching user message arrives from history', () => {
    const pending = { id: 'local', text: '问题', occurrence: 1, createdAt: new Date('2026-10-06T01:00:00Z') };
    const saved = message('saved', 'user', '问题', '2026-10-06T01:00:00Z');
    expect(withPendingUserMessages([saved], [pending]).map(item => item.id)).toEqual(['saved']);
  });

  it('distinguishes a repeated question from its earlier saved copy', () => {
    const saved = message('saved', 'user', '问题', '2026-10-06T01:00:00Z');
    const pending = nextPendingUserMessage('问题', [saved], []);
    expect(pending.occurrence).toBe(2);
    expect(withPendingUserMessages([saved], [pending]).map(item => item.id)).toEqual(['saved', pending.id]);
  });

  it('recognizes persisted user signals and does not add a duplicate fallback', () => {
    const saved = { ...message('signal-1', 'user', '问题', '2026-10-06T01:00:00Z'),
      role: 'signal', type: 'user', content: { format: 2,
        metadata: { signal: { type: 'user' } }, parts: [{ type: 'text', text: '问题' }] } } as MastraDBMessage;
    const pending = { id: 'local', text: '问题', occurrence: 1,
      createdAt: new Date('2026-10-06T01:00:00Z') };
    expect(withPendingUserMessages([saved], [pending]).map(item => item.id)).toEqual(['signal-1']);
  });
});
