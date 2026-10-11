import { describe, expect, it } from 'vitest';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { buildAgentAttachmentMessage } from './message-parts';
import {
  buildHistorySearchDocuments,
  MAX_HISTORY_SEARCH_RESULTS,
  searchHistoryDocuments,
} from './history-search-index';
import type { HistorySearchDocument } from './history-search-index';

function textMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  createdAt = '2026-10-06T01:00:00Z',
): MastraDBMessage {
  return {
    id,
    role,
    createdAt: new Date(createdAt),
    content: { format: 2, parts: [{ type: 'text', text }] },
  };
}

function partsMessage(
  id: string,
  role: 'user' | 'assistant',
  parts: MastraDBMessage['content']['parts'],
  createdAt = '2026-10-06T01:00:00Z',
): MastraDBMessage {
  return { id, role, createdAt: new Date(createdAt), content: { format: 2, parts } } as MastraDBMessage;
}

const thread = {
  id: 'thread-1',
  title: '测试会话',
  updatedAt: '2026-10-11T12:00:00.000Z',
};

describe('buildHistorySearchDocuments', () => {
  it('ignores system and notification text between a question and the assistant answer', () => {
    const messages = [
      textMessage('u1', 'user', '问题'),
      { id: 'notice', role: 'signal', createdAt: new Date('2026-10-06T01:00:01Z'),
        content: { format: 2, parts: [{ type: 'text', text: '系统通知里的秘密词' }] } },
      { id: 'system', role: 'system', createdAt: new Date('2026-10-06T01:00:02Z'),
        content: { format: 2, parts: [{ type: 'text', text: '系统提示里的秘密词' }] } },
      textMessage('a1', 'assistant', '真正的回答'),
    ] as MastraDBMessage[];
    const docs = buildHistorySearchDocuments(thread, messages);
    expect(docs).toHaveLength(1);
    expect(docs[0].answerText).toBe('真正的回答');
    expect(searchHistoryDocuments(docs, '秘密词').total).toBe(0);
  });
  it('indexes one document per nonempty user turn and groups assistant text', () => {
    const messages: MastraDBMessage[] = [
      textMessage('u1', 'user', '第一个问题', '2026-10-06T01:00:00Z'),
      textMessage('a1', 'assistant', '第一个回答', '2026-10-06T01:00:01Z'),
      textMessage('u2', 'user', '第二个问题', '2026-10-06T01:00:02Z'),
      textMessage('a2', 'assistant', '第二个回答', '2026-10-06T01:00:03Z'),
    ];
    const docs = buildHistorySearchDocuments(thread, messages);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      threadId: 'thread-1',
      threadTitle: '测试会话',
      threadUpdatedAt: '2026-10-11T12:00:00.000Z',
      userMessageId: 'u1',
      questionText: '第一个问题',
      answerText: '第一个回答',
    });
    expect(docs[1]).toMatchObject({
      userMessageId: 'u2',
      questionText: '第二个问题',
      answerText: '第二个回答',
    });
  });

  it('treats user-signal messages as user turns', () => {
    const signal = {
      ...textMessage('signal-1', 'user', '信号问题'),
      role: 'signal' as const,
      type: 'user',
      content: {
        format: 2,
        metadata: { signal: { type: 'user' } },
        parts: [{ type: 'text', text: '信号问题' }],
      },
    } as MastraDBMessage;
    const docs = buildHistorySearchDocuments(thread, [
      signal,
      textMessage('a1', 'assistant', '信号回答'),
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0].userMessageId).toBe('signal-1');
    expect(docs[0].questionText).toBe('信号问题');
  });

  it('skips tool, reasoning, stream errors, and attachment protocol from indexed text', () => {
    const attachmentText = buildAgentAttachmentMessage('请总结', [{
      attachmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'notes.txt',
      mimeType: 'text/plain',
    }]);
    const messages: MastraDBMessage[] = [
      textMessage('orphan', 'assistant', '孤立回答不应产生文档'),
      partsMessage('u1', 'user', [{ type: 'text', text: attachmentText }]),
      partsMessage('a1', 'assistant', [
        { type: 'reasoning', reasoning: 'SECRET_REASONING_alpha' },
        { type: 'tool-invocation', toolInvocation: {
          state: 'result', toolCallId: 'c1', toolName: 'search', args: {}, result: 'SECRET_TOOL_alpha',
        } },
        { type: 'text', text: '可见回答' },
        { type: 'text', text: '{"name":"Error","message":"流式错误","code":"E"}' },
      ] as never),
      partsMessage('u2', 'user', [
        { type: 'tool-invocation', toolInvocation: {
          state: 'call', toolCallId: 'c2', toolName: 'x', args: {},
        } },
      ]),
    ];
    const docs = buildHistorySearchDocuments(thread, messages);
    expect(docs).toHaveLength(1);
    expect(docs[0].questionText).toBe('请总结');
    expect(docs[0].answerText).toBe('可见回答');
    expect(docs[0].answerText).not.toContain('SECRET');
  });
});

describe('searchHistoryDocuments', () => {
  it('keeps searching 50 long history turns responsive', () => {
    const documents: HistorySearchDocument[] = Array.from({ length: 50 }, (_, index) => ({
      threadId: `t-${index}`, threadTitle: '长会话', threadUpdatedAt: '2026-10-11T00:00:00.000Z',
      userMessageId: `u-${index}`, questionText: '甲'.repeat(20_000), answerText: '',
    }));
    const start = performance.now();
    expect(searchHistoryDocuments(documents, '不存在的词').total).toBe(0);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
  it('prefers question matches when both question and answer match', () => {
    const documents: HistorySearchDocument[] = [{
      threadId: 't1',
      threadTitle: 'T',
      threadUpdatedAt: '2026-10-10T00:00:00.000Z',
      userMessageId: 'u1',
      questionText: 'overlap token',
      answerText: 'also overlap token here',
    }];
    const { results, total } = searchHistoryDocuments(documents, 'overlap');
    expect(total).toBe(1);
    expect(results[0].matchSource).toBe('question');
    expect(results[0].matchedSnippet).toContain('overlap');
  });

  it('matches literally with NFKC, case folding, brackets, and Chinese', () => {
    const documents: HistorySearchDocument[] = [{
      threadId: 't1',
      threadTitle: 'T',
      threadUpdatedAt: '2026-10-10T00:00:00.000Z',
      userMessageId: 'u1',
      questionText: '查询 [括号] 和 ＡＢＣ',
      answerText: '其他',
    }];
    expect(searchHistoryDocuments(documents, '  [括号]  ').total).toBe(1);
    expect(searchHistoryDocuments(documents, 'abc').total).toBe(1);
    expect(searchHistoryDocuments(documents, '括号').total).toBe(1);
  });

  it('does not treat query as regex markup', () => {
    const documents: HistorySearchDocument[] = [{
      threadId: 't1',
      threadTitle: 'T',
      threadUpdatedAt: '2026-10-10T00:00:00.000Z',
      userMessageId: 'u1',
      questionText: 'literal (parens) only',
      answerText: 'zzz',
    }];
    expect(searchHistoryDocuments(documents, '(parens)').total).toBe(1);
    expect(searchHistoryDocuments(documents, 'zzz').results[0].matchedSnippet).not.toContain('<');
  });

  it('orders question hits before answer hits, then newest threadUpdatedAt', () => {
    const documents: HistorySearchDocument[] = [
      {
        threadId: 'old',
        threadTitle: 'Old',
        threadUpdatedAt: '2026-10-01T00:00:00.000Z',
        userMessageId: 'u-old-a',
        questionText: 'other',
        answerText: 'needle in answer',
      },
      {
        threadId: 'new',
        threadTitle: 'New',
        threadUpdatedAt: '2026-10-11T00:00:00.000Z',
        userMessageId: 'u-new-a',
        questionText: 'other',
        answerText: 'needle in answer too',
      },
      {
        threadId: 'mid',
        threadTitle: 'Mid',
        threadUpdatedAt: '2026-10-05T00:00:00.000Z',
        userMessageId: 'u-mid-q',
        questionText: 'needle in question',
        answerText: 'also needle in answer',
      },
    ];
    const { results } = searchHistoryDocuments(documents, 'needle');
    expect(results.map(r => r.userMessageId)).toEqual(['u-mid-q', 'u-new-a', 'u-old-a']);
    expect(results[0].matchSource).toBe('question');
    expect(results[1].matchSource).toBe('answer');
    expect(results[2].matchSource).toBe('answer');
  });

  it('caps visible results at MAX_HISTORY_SEARCH_RESULTS but reports full total', () => {
    const documents: HistorySearchDocument[] = Array.from({ length: 150 }, (_, i) => ({
      threadId: `t-${i}`,
      threadTitle: `T${i}`,
      threadUpdatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      userMessageId: `u-${i}`,
      questionText: `hit-${i}`,
      answerText: '',
    }));
    const { results, total } = searchHistoryDocuments(documents, 'hit');
    expect(total).toBe(150);
    expect(results).toHaveLength(MAX_HISTORY_SEARCH_RESULTS);
  });

  it('builds a valid snippet when normalization changes string length', () => {
    const documents: HistorySearchDocument[] = [{
      threadId: 't1',
      threadTitle: 'T',
      threadUpdatedAt: '2026-10-10T00:00:00.000Z',
      userMessageId: 'u1',
      questionText: '前缀ＡＢＣ后缀',
      answerText: '',
    }];
    const { results } = searchHistoryDocuments(documents, 'abc');
    expect(results[0].matchedSnippet.length).toBeGreaterThan(0);
    expect(results[0].matchedSnippet.length).toBeLessThanOrEqual(180);
    expect(results[0].matchedSnippet).toMatch(/ＡＢＣ|ABC|abc/i);
  });
});
