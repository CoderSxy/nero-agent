import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentChat } from './AgentChat';

const sendMessage = vi.fn();
const cancelRun = vi.fn();
vi.mock('@mastra/react', () => ({ useChat: () => ({
  messages: [{ id: 'partial', role: 'assistant', content: { format: 2, parts: [{ type: 'text', text: '部分回复' }] } }],
  isRunning: false, sendMessage, cancelRun, toolCallApprovals: {}, approveToolCall: vi.fn(), declineToolCall: vi.fn(),
}) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Agent conversation', () => {
  it('sends in stream mode with the scoped thread', async () => {
    sendMessage.mockResolvedValue(undefined);
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]} onMessageSent={vi.fn()}
      models={{ chatModel: 'deepseek/deepseek-v4-pro', memoryModel: 'deepseek/deepseek-v4-flash' }} />);
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: '你好', mode: 'stream', threadId: 'thread-1', onChunk: expect.any(Function),
      model: 'deepseek/deepseek-v4-pro',
    })));
    expect(sendMessage.mock.calls[0][0].requestContext.get('nero-agent.memory-model'))
      .toBe('deepseek/deepseek-v4-flash');
  });
  it('keeps partial text visible when the stream fails', async () => {
    sendMessage.mockRejectedValue(new Error('stream disconnected'));
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]} onMessageSent={vi.fn()}
      models={{ chatModel: 'deepseek/deepseek-v4-flash', memoryModel: 'deepseek/deepseek-v4-flash' }} />);
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '继续' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '回复未完成：stream disconnected');
    expect(screen.getByText('部分回复')).toBeTruthy();
  });
});
