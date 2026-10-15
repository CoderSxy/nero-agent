import { describe, expect, it } from 'vitest';
import {
  filterThreadsBySource,
  sourceOfThread,
  withThreadSource,
} from './thread-source';
import type { Thread } from './thread-scope';

function thread(id: string, metadata?: unknown): Thread {
  return {
    id,
    title: id,
    resourceId: 'user',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: metadata as Thread['metadata'],
  } as Thread;
}

describe('thread source', () => {
  it('treats missing or unknown source as history default', () => {
    expect(sourceOfThread(undefined)).toBe('default');
    expect(sourceOfThread({})).toBe('default');
    expect(sourceOfThread({ neroAgentSourceType: 'other' })).toBe('default');
    expect(sourceOfThread({ neroAgentSourceType: 'schedule' })).toBe('schedule');
  });

  it('filters history and schedule threads separately', () => {
    const threads = [
      thread('a'),
      thread('b', { neroAgentSourceType: 'default' }),
      thread('c', { neroAgentSourceType: 'schedule' }),
    ];
    expect(filterThreadsBySource(threads, 'default').map((item) => item.id)).toEqual(['a', 'b']);
    expect(filterThreadsBySource(threads, 'schedule').map((item) => item.id)).toEqual(['c']);
  });

  it('writes default source metadata for ordinary threads', () => {
    expect(withThreadSource({ neroAgentModels: { chatModel: 'x' } }, 'default')).toEqual({
      neroAgentModels: { chatModel: 'x' },
      neroAgentSourceType: 'default',
    });
  });
});
