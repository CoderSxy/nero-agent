import { describe, expect, it } from 'vitest';
import { messageParts, streamError } from './message-parts';

describe('stream error display', () => {
  it('extracts a safe message without exposing a server stack', () => {
    expect(streamError('{"name":"Error","message":"缺少 API Key","stack":"secret path"}')).toBe('缺少 API Key');
    expect(streamError('正常的回复')).toBeNull();
  });
  it('preserves text and tool order within one message', () => {
    const parts = messageParts({ id: 'one', role: 'assistant', content: { format: 2, parts: [
      { type: 'text', text: 'before' },
      { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'call', toolName: 'search', args: {}, result: 'ok' } },
      { type: 'text', text: 'after' },
    ] } } as never);
    expect(parts.map(part => part.kind)).toEqual(['text', 'tool', 'text']);
  });
});
