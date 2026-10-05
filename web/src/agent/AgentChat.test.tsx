import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentChat } from './AgentChat';
import type { SafeModel } from './model-catalog-client';

const sendMessage = vi.fn();
const cancelRun = vi.fn();
const chatRef = 'public:11111111-1111-4111-8111-111111111111' as const;
const memoryRef = 'private:22222222-2222-4222-8222-222222222222' as const;
const models = { chatModel: chatRef, memoryModel: memoryRef };
const catalog = [chatRef, memoryRef].map((ref, index) => ({ ref,
  scope: index === 0 ? 'public' : 'private', displayName: index === 0 ? '默认模型' : '个人模型',
  providerId: 'test', modelId: `m${index}`, baseUrl: 'https://example.test', apiMode: 'chat',
  enabled: true, hasApiKey: true, keyHint: '1234',
})) as SafeModel[];
let mockMessages: Array<{ id: string; role: string; content: { format: number; parts: Array<{ type: string; text: string }> } }> =
  [{ id: 'partial', role: 'assistant', content: { format: 2, parts: [{ type: 'text', text: '部分回复' }] } }];
vi.mock('@mastra/react', () => ({ useChat: () => ({
  messages: mockMessages,
  isRunning: false, sendMessage, cancelRun, toolCallApprovals: {}, approveToolCall: vi.fn(), declineToolCall: vi.fn(),
}) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); mockMessages =
  [{ id: 'partial', role: 'assistant', content: { format: 2, parts: [{ type: 'text', text: '部分回复' }] } }]; });

describe('Agent conversation', () => {
  it('shows the selected model in composer and forwards changes', () => {
    const change = vi.fn();
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]} onMessageSent={vi.fn()}
      models={models} catalog={catalog} onModelChange={change} />);
    const select = screen.getByRole('combobox', { name: '模型' });
    expect(select.textContent).toContain('默认模型');
    fireEvent.click(select);
    fireEvent.click(screen.getByRole('option', { name: /个人模型/ }));
    expect(change).toHaveBeenCalledWith(memoryRef);
  });
  it('waits for a model change to save before allowing a send', () => {
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]} onMessageSent={vi.fn()}
      models={models} catalog={catalog} modelDisabled />);
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '你好' } });
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('centers the composer until the first message is submitted, then docks the same input', async () => {
    mockMessages = [];
    sendMessage.mockResolvedValue(undefined);
    const { container } = render(<AgentChat threadId="new-thread" resourceId="agent" initialMessages={[]}
      onMessageSent={vi.fn()} models={models} />);
    const shell = container.querySelector('[data-slot="chat-shell"]');
    const input = screen.getByRole('textbox', { name: '发送消息' });
    expect(shell?.classList.contains('chat-shell--empty')).toBe(true);
    fireEvent.change(input, { target: { value: '你好' } });
    expect(shell?.classList.contains('chat-shell--empty')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(shell?.classList.contains('chat-shell--empty')).toBe(false));
    expect(screen.getByRole('textbox', { name: '发送消息' })).toBe(input);
  });
  it('sends in stream mode with refs in context and no model option', async () => {
    sendMessage.mockResolvedValue(undefined);
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]} onMessageSent={vi.fn()}
      models={models} />);
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: '你好', mode: 'stream', threadId: 'thread-1', onChunk: expect.any(Function),
    })));
    const options = sendMessage.mock.calls[0][0];
    expect('model' in options).toBe(false);
    expect(options.requestContext.get('nero-agent.chat-model-ref')).toBe(chatRef);
    expect(options.requestContext.get('nero-agent.memory-model-ref')).toBe(memoryRef);
  });
  it('blocks sending and explains why when the thread models are unusable', () => {
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]} onMessageSent={vi.fn()}
      models={models} sendBlockedReason="当前模型已不可用，请重新选择" />);
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '你好' } });
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('textbox', { name: '发送消息' }).closest('form')!);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(screen.getByText('当前模型已不可用，请重新选择')).toBeTruthy();
  });
  it('does not send when no models are selected', () => {
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]} onMessageSent={vi.fn()}
      models={null} />);
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '你好' } });
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it('keeps partial text visible when the stream fails', async () => {
    sendMessage.mockRejectedValue(new Error('stream disconnected'));
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]} onMessageSent={vi.fn()}
      models={models} />);
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '继续' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '回复未完成：stream disconnected');
    expect(screen.getByText('部分回复')).toBeTruthy();
  });
});
