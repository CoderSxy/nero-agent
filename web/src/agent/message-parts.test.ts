import { describe, expect, it } from 'vitest';
import {
  buildAgentAttachmentMessage,
  DEFAULT_ATTACHMENT_PROMPT,
  messageParts,
  parseAttachmentIdsFromText,
  skillActivations,
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
  it('shows process parts before a completed answer when they arrive after its text', () => {
    const parts = messageParts({ id: 'scheduled', role: 'assistant', content: { format: 2, parts: [
      { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'weather', toolName: 'search', args: {}, result: 'sunny' } },
      { type: 'text', text: '苏州今天多云。' },
      { type: 'reasoning', reasoning: '先核对逐小时天气', state: 'done' },
      { type: 'data-om-buffering-end', data: { cycleId: 'weather-buffer', operationType: 'observation' } },
    ] } } as never);
    expect(parts.map(part => part.kind)).toEqual(['tool', 'reasoning', 'observation', 'text']);
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
  it('dedupes skill activations and keeps a failed load distinct from success', () => {
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const event = {
      serverExecutionId: 'exec-1', skillId: 'skill-1', name: 'checklist', version: 3,
      manifestHash: hash, status: 'loaded',
    };
    const failed = { serverExecutionId: 'exec-1', skillId: 'skill-2', name: 'missing', status: 'failed', errorCode: 'SKILL_NOT_FOUND' };
    const activations = skillActivations({ id: 'one', role: 'assistant', content: { format: 2,
      metadata: { neroSkillActivations: [event, failed] },
      parts: [
        { type: 'data-nero-skill-activation', data: event },
        { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'call', toolName: 'skill',
          args: { name: 'checklist' }, result: { ok: true, skill: {
            skillId: 'skill-1', name: 'checklist', version: 3, manifestHash: hash,
          } } } },
        { type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'pending', toolName: 'skill',
          args: { name: 'checklist' } } },
        { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'path', toolName: 'skill',
          args: {}, result: { ok: true, skill: { skillId: 'skill-9', name: '/Users/secret/skill', version: 1, manifestHash: hash } } } },
      ],
    } } as never);
    expect(activations).toEqual([
      expect.objectContaining({ skillId: 'skill-1', name: 'checklist', version: 3, status: 'loaded', hashPrefix: '01234567' }),
      expect.objectContaining({ skillId: 'skill-2', name: 'missing', status: 'failed', errorCode: 'SKILL_NOT_FOUND' }),
    ]);
    expect(activations.some(item => item.name.includes('/Users/'))).toBe(false);
  });
});

describe('structured chart delivery',()=>{
  const message=(parts:any[])=>({role:'assistant',content:{format:2,parts}} as any);
  it('does not expose raw protocol JSON while the chart is pending',()=>{
    expect(messageParts(message([{type:'data-nero-chart',data:{version:2,status:'pending'}},{type:'text',text:'{"status":"ready","dataset":'}]))).toEqual([]);
  });
  it('renders only the canonical chart and attaches failure to its own answer',()=>{
    const ready=messageParts(message([{type:'text',text:'{"raw":"data"}'},{type:'data-nero-chart',data:{version:2,status:'pending'}},{type:'data-nero-chart',data:{version:2,status:'ready',markdown:'```echarts\n{}\n```'}}]));
    expect(ready).toEqual([{kind:'text',text:'```echarts\n{}\n```'}]);
    const failed=messageParts(message([{type:'data-nero-chart',data:{version:2,status:'pending'}},{type:'text',text:'ASCII chart'},{type:'data-nero-delivery',data:{version:2,status:'failed',reason:'missing-chart',message:'模型未返回结构化图表数据'}}]));
    expect(failed).toEqual([{kind:'delivery-error',reason:'missing-chart',message:'模型未返回结构化图表数据'}]);
  });
  it('shows a partial outcome on the answer itself',()=>{
    const parts=messageParts(message([{type:'text',text:'只有温度'},{type:'data-nero-task-outcome',data:{runId:'run-1',revision:1,status:'partial',verification:'verified',requirements:[{id:'weather.condition',status:'missing'}]}}]));
    expect(parts.some(part=>part.kind==='text'&&part.text.includes('部分完成')&&part.text.includes('weather.condition'))).toBe(true);
  });
  it('keeps the weather summary beside the chart markdown',()=>{
    const markdown='```echarts\n{"series":[]}\n```\n\n2026-10-22 大部晴朗 日均相对湿度 70%';
    const parts=messageParts(message([{type:'data-nero-chart',data:{version:2,schemaVersion:2,kind:'weather',status:'ready',markdown}}]));
    expect(parts).toEqual([{kind:'text',text:markdown}]);
    expect(parts[0].kind==='text' && parts[0].text).toContain('日均相对湿度');
  });
  it('shows the task outcome on the same answer', () => {
    const parts = messageParts(message([
      { type: 'text', text: '只有气温。' },
      { type: 'data-nero-task-outcome', data: { runId: 'run-1', revision: 1, status: 'partial', verification: 'verified', requirements: [{ id: 'weather.condition', status: 'missing' }] } },
    ]));
    expect(parts.map(part => part.kind === 'text' ? part.text : '')).toContain('部分完成，缺少：weather.condition。');
  });
});
