import { describe, expect, it } from 'vitest';
import {
  buildAgentAttachmentMessage,
  DEFAULT_ATTACHMENT_PROMPT,
  messageParts,
  parseAttachmentIdsFromText,
  streamError,
  stripAttachmentProtocol,
  userVisibleText,
} from './message-parts';

describe('attachment message protocol', () => {
  it('embeds attachment ids for the agent and strips them for the user bubble', () => {
    const agentText = buildAgentAttachmentMessage('请总结', [{
      attachmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'notes.txt',
      mimeType: 'text/plain',
    }]);
    expect(agentText).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(agentText).toContain('notes.txt');
    expect(agentText).toContain('read_attached_file');
    expect(stripAttachmentProtocol(agentText)).toBe('请总结');
    expect(userVisibleText(agentText)).toBe('请总结');
    expect(parseAttachmentIdsFromText(agentText)).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  });

  it('uses the default prompt when only attachments are present', () => {
    const agentText = buildAgentAttachmentMessage('', [{
      attachmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'shot.png',
      mimeType: 'image/png',
    }]);
    expect(agentText.startsWith(DEFAULT_ATTACHMENT_PROMPT)).toBe(true);
    expect(userVisibleText(agentText)).toBe(DEFAULT_ATTACHMENT_PROMPT);
  });
});

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
  it('replaces the observation start with its completed cycle and preserves detail', () => {
    const parts = messageParts({ id: 'one', role: 'assistant', content: { format: 2, parts: [
      { type: 'data-om-observation-start', data: { cycleId: 'cycle-1', tokensToObserve: 93500 } },
      { type: 'data-om-observation-end', data: { cycleId: 'cycle-1', tokensObserved: 93500,
        observationTokens: 382, durationMs: 29700, observations: 'Date: Oct 9, 2026\n* 🟢 (14:47) Summary',
        currentTask: 'Continue research', suggestedResponse: 'Answer concisely' } },
    ] } } as never);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: 'observation', state: 'complete', cycleId: 'cycle-1',
      data: { tokensObserved: 93500, observationTokens: 382, durationMs: 29700,
        currentTask: 'Continue research', suggestedResponse: 'Answer concisely' } });
  });
});
