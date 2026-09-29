import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from './MessageList';

afterEach(cleanup);

const pendingMessage = { id: 'a', role: 'assistant', content: { format: 2, parts: [
  { type: 'text', text: '正在执行' },
  { type: 'tool-invocation', toolInvocation: { state: 'approval-requested', toolCallId: 'tool-1', toolName: 'search', args: { query: 'hello' } } },
] } };

describe('message tools and stream state', () => {
  it('keeps partial text and displays an unfinished error', () => {
    render(<MessageList messages={[pendingMessage] as never} isRunning={false} error="连接断开"
      onApprove={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText('正在执行')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('回复未完成');
  });
  it('submits an approval once while pending', async () => {
    let resolve!: () => void;
    const approve = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    render(<MessageList messages={[pendingMessage] as never} isRunning={false} error={null}
      onApprove={approve} onDecline={vi.fn()} />);
    const button = screen.getByRole('button', { name: /批准|Approve/i });
    fireEvent.click(button); fireEvent.click(button);
    expect(approve).toHaveBeenCalledTimes(1);
    resolve();
  });
  it('does not offer approval for an ordinary running tool', () => {
    const message = { ...pendingMessage, content: { ...pendingMessage.content, parts: [
      { type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'tool-1', toolName: 'search', args: {} } },
    ] } };
    render(<MessageList messages={[message] as never} isRunning={true} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /批准|Approve/i })).toBeNull();
  });
  it('allows a retry when the approval API fails', async () => {
    const approve = vi.fn().mockRejectedValue(new Error('network error'));
    render(<MessageList messages={[pendingMessage] as never} isRunning={false} error={null}
      onApprove={approve} onDecline={vi.fn()} />);
    const button = screen.getByRole('button', { name: /批准|Approve/i });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    fireEvent.click(button);
    expect(approve).toHaveBeenCalledTimes(2);
  });
});
