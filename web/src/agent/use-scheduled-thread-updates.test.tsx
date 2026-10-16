import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { useScheduledThreadUpdates } from './use-scheduled-thread-updates';

const subscribeToThread = vi.hoisted(() => vi.fn());
const listTaskRuns = vi.hoisted(() => vi.fn());
const loadScopedThread = vi.hoisted(() => vi.fn());
vi.mock('./client', () => ({ AGENT_ID: 'agent', client: { getAgent: () => ({ subscribeToThread }) } }));
vi.mock('./scheduled-tasks-api', () => ({ listTaskRuns }));
vi.mock('./thread-scope', () => ({ loadScopedThread }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('scheduled conversation updates', () => {
  it('shows streamed chunks, then reconciles the saved answer when the run completes', async () => {
    let onChunk!: (chunk: unknown) => void;
    const unsubscribe = vi.fn();
    subscribeToThread.mockResolvedValue({
      processDataStream: ({ onChunk: receive }: { onChunk: typeof onChunk }) => {
        onChunk = receive;
        return new Promise<void>(() => {});
      },
      unsubscribe,
    });
    listTaskRuns.mockResolvedValueOnce({ items: [{ id: 'run-1', status: 'running' }], total: 1 })
      .mockResolvedValueOnce({ items: [{ id: 'run-1', status: 'succeeded' }], total: 1 });
    const finalMessage = { id: 'answer', role: 'assistant', content: { format: 2,
      parts: [{ type: 'text', text: '完整回答' }] } } as MastraDBMessage;
    loadScopedThread.mockResolvedValueOnce({ messages: [] })
      .mockResolvedValue({ messages: [finalMessage] });
    const settled = vi.fn();
    const { result } = renderHook(() => {
      const [messages, setMessages] = useState<MastraDBMessage[]>([]);
      const running = useScheduledThreadUpdates({
        run: { taskId: 'task-1', runId: 'run-1' }, threadId: 'thread-1', resourceId: 'owner-1',
        setMessages, onSettled: settled,
      });
      return { messages, running };
    });
    await waitFor(() => expect(subscribeToThread).toHaveBeenCalledWith({
      threadId: 'thread-1', resourceId: 'owner-1',
    }));
    await waitFor(() => expect(listTaskRuns).toHaveBeenCalledTimes(1));
    act(() => {
      onChunk({ type: 'start', runId: 'model-run', from: 'AGENT', payload: { messageId: 'answer' } });
      onChunk({ type: 'text-start', runId: 'model-run', from: 'AGENT', payload: { id: 'text-1' } });
      onChunk({ type: 'text-delta', runId: 'model-run', from: 'AGENT', payload: { id: 'text-1', text: '正在回答' } });
    });
    expect(result.current.messages[0]?.content.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: '正在回答' }),
    ]));
    expect(result.current.running).toBe(true);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_600)); });
    await waitFor(() => expect(result.current.messages).toEqual([finalMessage]));
    expect(result.current.running).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('continues from saved messages when the live subscription disconnects', async () => {
    subscribeToThread.mockResolvedValue({
      processDataStream: () => Promise.reject(new Error('connection closed')),
      unsubscribe: vi.fn(),
    });
    listTaskRuns.mockResolvedValue({ items: [{ id: 'run-1', status: 'running' }], total: 1 });
    const partial = { id: 'answer', role: 'assistant', content: { format: 2,
      parts: [{ type: 'text', text: '第一段' }] } } as MastraDBMessage;
    const continued = { ...partial, content: { ...partial.content,
      parts: [{ type: 'text', text: '第一段和第二段' }] } } as MastraDBMessage;
    loadScopedThread.mockResolvedValueOnce({ messages: [partial] })
      .mockResolvedValue({ messages: [continued] });
    const { result, unmount } = renderHook(() => {
      const [messages, setMessages] = useState<MastraDBMessage[]>([]);
      useScheduledThreadUpdates({ run: { taskId: 'task-1', runId: 'run-1' },
        threadId: 'thread-1', resourceId: 'owner-1', setMessages });
      return messages;
    });
    await waitFor(() => expect(result.current[0]?.content.parts).toEqual(partial.content.parts));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_600)); });
    expect(result.current[0]?.content.parts).toEqual(continued.content.parts);
    unmount();
  });
  it('closes a subscription that connects after the run already finished', async () => {
    let connect!: (value: { processDataStream: () => Promise<void>; unsubscribe: () => void }) => void;
    subscribeToThread.mockImplementation(() => new Promise(resolve => { connect = resolve; }));
    listTaskRuns.mockResolvedValue({ items: [{ id: 'run-1', status: 'succeeded' }], total: 1 });
    loadScopedThread.mockResolvedValue({ messages: [] });
    const processDataStream = vi.fn();
    const unsubscribe = vi.fn();
    const { result } = renderHook(() => {
      const [, setMessages] = useState<MastraDBMessage[]>([]);
      return useScheduledThreadUpdates({ run: { taskId: 'task-1', runId: 'run-1' },
        threadId: 'thread-1', resourceId: 'owner-1', setMessages });
    });
    await waitFor(() => expect(result.current).toBe(false));
    await act(async () => { connect({ processDataStream, unsubscribe }); });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(processDataStream).not.toHaveBeenCalled();
  });
  it('does not duplicate saved text when a late subscription replays the same chunks', async () => {
    let onChunk!: (chunk: unknown) => void;
    subscribeToThread.mockResolvedValue({
      processDataStream: ({ onChunk: receive }: { onChunk: typeof onChunk }) => {
        onChunk = receive;
        return new Promise<void>(() => {});
      },
      unsubscribe: vi.fn(),
    });
    listTaskRuns.mockResolvedValue({ items: [{ id: 'run-1', status: 'running' }], total: 1 });
    loadScopedThread.mockResolvedValue({ messages: [] });
    const saved = { id: 'answer', role: 'assistant', content: { format: 2,
      parts: [{ type: 'text', text: 'Hello' }] } } as MastraDBMessage;
    const { result, unmount } = renderHook(() => {
      const [messages, setMessages] = useState<MastraDBMessage[]>([saved]);
      useScheduledThreadUpdates({ run: { taskId: 'task-1', runId: 'run-1' },
        threadId: 'thread-1', resourceId: 'owner-1', setMessages });
      return messages;
    });
    await waitFor(() => expect(subscribeToThread).toHaveBeenCalled());
    await waitFor(() => expect(onChunk).toBeTypeOf('function'));
    act(() => {
      onChunk({ type: 'start', runId: 'model-run', from: 'AGENT', payload: { messageId: 'answer' } });
      onChunk({ type: 'text-start', runId: 'model-run', from: 'AGENT', payload: { id: 'text-1' } });
      onChunk({ type: 'text-delta', runId: 'model-run', from: 'AGENT', payload: { id: 'text-1', text: 'Hello' } });
      onChunk({ type: 'text-delta', runId: 'model-run', from: 'AGENT', payload: { id: 'text-1', text: ' world' } });
    });
    const answer = result.current[0]?.content.parts.filter(part => part.type === 'text')
      .map(part => part.text).join('');
    expect(answer).toBe('Hello world');
    unmount();
  });
  it('updates a tool call when its result streams in', async () => {
    let onChunk!: (chunk: unknown) => void;
    subscribeToThread.mockResolvedValue({
      processDataStream: ({ onChunk: receive }: { onChunk: typeof onChunk }) => {
        onChunk = receive;
        return new Promise<void>(() => {});
      },
      unsubscribe: vi.fn(),
    });
    listTaskRuns.mockResolvedValue({ items: [{ id: 'run-1', status: 'running' }], total: 1 });
    loadScopedThread.mockResolvedValue({ messages: [] });
    const { result, unmount } = renderHook(() => {
      const [messages, setMessages] = useState<MastraDBMessage[]>([]);
      useScheduledThreadUpdates({ run: { taskId: 'task-1', runId: 'run-1' },
        threadId: 'thread-1', resourceId: 'owner-1', setMessages });
      return messages;
    });
    await waitFor(() => expect(onChunk).toBeTypeOf('function'));
    act(() => {
      onChunk({ type: 'start', runId: 'model-run', from: 'AGENT', payload: { messageId: 'answer' } });
      onChunk({ type: 'tool-call', runId: 'model-run', from: 'AGENT', payload: {
        toolCallId: 'search-1', toolName: 'search', args: { q: 'weather' },
      } });
    });
    expect(result.current[0]?.content.parts[0]).toMatchObject({ type: 'tool-invocation',
      toolInvocation: { state: 'call' } });
    act(() => onChunk({ type: 'tool-result', runId: 'model-run', from: 'AGENT', payload: {
      toolCallId: 'search-1', toolName: 'search', result: 'sunny',
    } }));
    expect(result.current[0]?.content.parts[0]).toMatchObject({ type: 'tool-invocation',
      toolInvocation: { state: 'result', result: 'sunny' } });
    unmount();
  });
});
