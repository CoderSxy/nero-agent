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
  it('keeps streamed reasoning in order around tool calls', () => {
    const parts = messageParts({ id: 'one', role: 'assistant', content: { format: 2, parts: [
      { type: 'reasoning', reasoning: '先查天气', state: 'done' },
      { type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'search', toolName: 'tavily_search', args: { query: '苏州天气' } } },
      { type: 'reasoning', reasoning: '正在核对结果', state: 'streaming' },
    ] } } as never);
    expect(parts.map(part => part.kind)).toEqual(['reasoning', 'tool', 'reasoning']);
    expect(parts[2]).toMatchObject({ kind: 'reasoning', text: '正在核对结果', streaming: true });
  });
  it('keeps observational memory markers with their token estimate', () => {
    const parts = messageParts({ id: 'one', role: 'assistant', content: { format: 2, parts: [
      { type: 'data-om-observation-start', data: { tokensToObserve: 42600 } },
      { type: 'data-om-observation-end', data: { tokensObserved: 42600 } },
    ] } } as never);
    expect(parts).toMatchObject([
      { kind: 'observation', state: 'complete', tokens: 42600 },
      { kind: 'observation', state: 'complete', tokens: 42600 },
    ]);
  });
});
