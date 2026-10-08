import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MessageList } from './MessageList';

beforeAll(() => vi.stubGlobal('PointerEvent', MouseEvent));
afterAll(() => vi.unstubAllGlobals());
afterEach(cleanup);

const pendingMessage = { id: 'a', role: 'assistant', content: { format: 2, parts: [
  { type: 'text', text: '正在执行' },
  { type: 'tool-invocation', toolInvocation: { state: 'approval-requested', toolCallId: 'tool-1', toolName: 'search', args: { query: 'hello' } } },
] } };

describe('message tools and stream state', () => {
  it('shows live reasoning and a bordered running process', () => {
    const message = { id: 'live', role: 'assistant', content: { format: 2, parts: [
      { type: 'reasoning', reasoning: '正在规划搜索', state: 'streaming' },
      { type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'search', toolName: 'tavily_search', args: { query: '苏州天气' } } },
    ] } };
    const { container } = render(<MessageList messages={[message] as never} isRunning error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getByText('Reasoning')).toBeTruthy();
    expect(screen.getByText('正在规划搜索')).toBeTruthy();
    expect(screen.getByText('苏州天气')).toBeTruthy();
    expect(container.querySelector('.process-message--running')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('正在处理');
  });
  it('shows an observing badge only for an observation marker', () => {
    const message = { id: 'observing', role: 'assistant', content: { format: 2, parts: [
      { type: 'data-om-observation-start', data: { tokensToObserve: 42600 } },
    ] } };
    render(<MessageList messages={[message] as never} isRunning error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getByText('Observing ~42.6k tokens')).toBeTruthy();
    expect(screen.queryByText('正在处理…')).toBeNull();
  });
  it('renders a saved user signal as a user bubble', () => {
    const signal = { id: 'signal-1', role: 'signal', type: 'user', content: { format: 2,
      metadata: { signal: { type: 'user' } }, parts: [{ type: 'text', text: '刚发送的消息' }] } };
    render(<MessageList messages={[signal] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getByText('刚发送的消息').closest('[data-from]')?.getAttribute('data-from')).toBe('user');
  });
  it('renders a suspended ask_user as choices and submits the selected answer', async () => {
    const answer = vi.fn().mockResolvedValue(undefined);
    const message = { id: 'question', role: 'assistant', content: { format: 2, metadata: {
      mode: 'stream', suspendedTools: { ask_user: { toolCallId: 'ask-1', suspendPayload: {
        question: '采用哪种语言？', selectionMode: 'single_select', options: [
          { label: 'Python', description: '提供 Python 示例' }, { label: 'JavaScript', description: '提供 JS 示例' },
        ],
      } } },
    }, parts: [{ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'ask-1',
      toolName: 'ask_user', args: { question: '采用哪种语言？' } } }] } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={answer} />);
    expect(screen.getByText('采用哪种语言？')).toBeTruthy();
    expect(screen.getByText('提供 Python 示例')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /批准|Approve/i })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Python/ }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('ask-1', 'Python'));
  });

  it('submits free-text and multi-select ask_user answers in their expected shapes', async () => {
    const answer = vi.fn().mockResolvedValue(undefined);
    const makeMessage = (id: string, payload: unknown) => ({ id, role: 'assistant', content: { format: 2,
      metadata: { mode: 'stream', suspendedTools: { ask_user: { toolCallId: id, suspendPayload: payload } } },
      parts: [{ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: id,
        toolName: 'ask_user', args: payload } }],
    } });
    const { rerender } = render(<MessageList messages={[makeMessage('free', { question: '补充说明？' })] as never}
      isRunning={false} error={null} onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={answer} />);
    fireEvent.change(screen.getByRole('textbox', { name: '补充说明？' }), { target: { value: '  详细一点  ' } });
    fireEvent.click(screen.getByRole('button', { name: /提交|Submit answer/i }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('free', '详细一点'));
    rerender(<MessageList messages={[makeMessage('multi', { question: '选择内容', selectionMode: 'multi_select',
      options: [{ label: '示例' }, { label: '测试' }] })] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={answer} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '示例' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '测试' }));
    fireEvent.click(screen.getByRole('button', { name: /提交|Submit answer/i }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('multi', ['示例', '测试']));
  });

  it('does not mistake another suspended tool for an approval', () => {
    const message = { id: 'suspended', role: 'assistant', content: { format: 2,
      metadata: { mode: 'stream', suspendedTools: { custom_tool: { toolCallId: 'custom-1', suspendPayload: {
        reason: 'waiting',
      } } } }, parts: [{ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'custom-1',
        toolName: 'custom_tool', args: { input: 'x' } } }],
    } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /批准|Approve/i })).toBeNull();
    expect(screen.getByText(/已暂停/)).toBeTruthy();
  });
  it('waits for ask_user to suspend before offering its answer form', () => {
    const message = { id: 'running-question', role: 'assistant', content: { format: 2, parts: [
      { type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'ask-2', toolName: 'ask_user',
        args: { question: '请选择语言', options: [{ label: 'Python' }] } } },
    ] } };
    render(<MessageList messages={[message] as never} isRunning error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.queryByText('请选择语言')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('does not offer an answer for an unfinished ask_user call without suspension data', () => {
    const message = { id: 'unfinished-question', role: 'assistant', content: { format: 2, parts: [
      { type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'ask-4', toolName: 'ask_user',
        args: { question: '选择语言', options: [{ label: 'Python' }] } } },
    ] } };
    render(<MessageList messages={[message] as never} isRunning={false} error="连接中断"
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('restores a real approval from message metadata after remount', () => {
    const message = { id: 'approval', role: 'assistant', content: { format: 2,
      metadata: { mode: 'stream', requireApprovalMetadata: { 'tool-2': {
        toolCallId: 'tool-2', toolName: 'execute_command', args: { command: 'pwd' },
      } } }, parts: [{ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'tool-2',
        toolName: 'execute_command', args: { command: 'pwd' } } }],
    } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getByRole('button', { name: /批准|Approve/i })).toBeTruthy();
  });

  it('shows the answered ask_user question from history without asking again', () => {
    const message = { id: 'answered', role: 'assistant', content: { format: 2, parts: [
      { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'ask-3', toolName: 'ask_user',
        args: { question: '选择语言', options: [{ label: 'Python' }] },
        result: { content: 'User answered: Python', isError: false } } },
    ] } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getByText('选择语言')).toBeTruthy();
    expect(screen.getByText('User answered: Python')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });
  it('keeps partial text and displays an unfinished error', () => {
    render(<MessageList messages={[pendingMessage] as never} isRunning={false} error="连接断开"
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getByText('正在执行')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('回复未完成');
  });
  it('submits an approval once while pending', async () => {
    let resolve!: () => void;
    const approve = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    render(<MessageList messages={[pendingMessage] as never} isRunning={false} error={null}
      onApprove={approve} onDecline={vi.fn()} onAnswer={vi.fn()} />);
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
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /批准|Approve/i })).toBeNull();
  });
  it('allows a retry when the approval API fails', async () => {
    const approve = vi.fn().mockRejectedValue(new Error('network error'));
    render(<MessageList messages={[pendingMessage] as never} isRunning={false} error={null}
      onApprove={approve} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    const button = screen.getByRole('button', { name: /批准|Approve/i });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    fireEvent.click(button);
    expect(approve).toHaveBeenCalledTimes(2);
  });
});
