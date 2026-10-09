import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentChat } from './AgentChat';
import type { SafeModel } from './model-catalog-client';
import type { PendingUserMessage } from './pending-user-message';

const sendMessage = vi.fn();
const cancelRun = vi.fn();
const approveToolCall = vi.fn();
const uploadWorkspaceFile = vi.hoisted(() => vi.fn());
const listWorkspaceFiles = vi.hoisted(() => vi.fn());
const fetchWorkspaceFile = vi.hoisted(() => vi.fn());
let chatOptions: { enableThreadSignals?: boolean } | undefined;
let mockRunning = false;
const chatRef = 'public:11111111-1111-4111-8111-111111111111' as const;
const memoryRef = 'private:22222222-2222-4222-8222-222222222222' as const;
const models = { chatModel: chatRef, memoryModel: memoryRef };
const catalog = [chatRef, memoryRef].map((ref, index) => ({ ref,
  scope: index === 0 ? 'public' : 'private', displayName: index === 0 ? '默认模型' : '个人模型',
  providerId: 'test', modelId: `m${index}`, baseUrl: 'https://example.test', apiMode: 'chat',
  enabled: true, hasApiKey: true, keyHint: '1234', supportsVision: false,
})) as SafeModel[];
let mockMessages: Array<{ id: string; role: string; content: { format: number; parts: Array<{ type: string; text: string }> } }> =
  [{ id: 'partial', role: 'assistant', content: { format: 2, parts: [{ type: 'text', text: '部分回复' }] } }];
vi.mock('@mastra/react', () => ({ useChat: (options: { enableThreadSignals?: boolean }) => {
  chatOptions = options;
  return {
    messages: mockMessages,
    isRunning: mockRunning, sendMessage, cancelRun, toolCallApprovals: {}, approveToolCall, declineToolCall: vi.fn(),
  };
} }));
vi.mock('./client', () => ({
  AGENT_ID: 'agent', listWorkspaceFiles, fetchWorkspaceFile, fetchUserFile: vi.fn(),
  uploadWorkspaceFile: (...args: unknown[]) => uploadWorkspaceFile(...args),
}));
vi.mock('./attachment-client', () => ({
  uploadWorkspaceFile: (...args: unknown[]) => uploadWorkspaceFile(...args),
  prepareAttachments: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); mockRunning = false; mockMessages =
  [{ id: 'partial', role: 'assistant', content: { format: 2, parts: [{ type: 'text', text: '部分回复' }] } }]; });

describe('Agent conversation', () => {
  it('notifies the workspace file list when a run finishes', () => {
    const changed = vi.fn();
    mockRunning = true;
    const { rerender } = render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]}
      onMessageSent={vi.fn()} onFilesChanged={changed} models={models} />);
    mockRunning = false;
    rerender(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]}
      onMessageSent={vi.fn()} onFilesChanged={changed} models={models} />);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('resumes ask_user with the selected option instead of a bare approval', async () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    approveToolCall.mockResolvedValue(undefined);
    mockMessages = [{ id: 'question', role: 'assistant', content: { format: 2,
      metadata: { mode: 'stream', suspendedTools: { ask_user: { toolCallId: 'ask-1', suspendPayload: {
        question: '选择语言', selectionMode: 'single_select', options: [{ label: 'Python' }, { label: 'JavaScript' }],
      } } } },
      parts: [{ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'ask-1',
        toolName: 'ask_user', args: { question: '选择语言' } } }],
    } } as never];
    try {
      render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]} onMessageSent={vi.fn()}
        models={models} />);
      fireEvent.click(screen.getByRole('radio', { name: 'Python' }));
      await waitFor(() => expect(approveToolCall).toHaveBeenCalledWith('ask-1', 'Python'));
    } finally { vi.unstubAllGlobals(); }
  });
  it('keeps a submitted user bubble when the chat unmounts before history catches up', async () => {
    mockMessages = [];
    sendMessage.mockResolvedValue(undefined);
    function SwitchingChat() {
      const [visible, setVisible] = useState(true);
      const [pending, setPending] = useState<PendingUserMessage[]>([]);
      return <><button type="button" onClick={() => setVisible(value => !value)}>切换会话</button>
        {visible && <AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]}
          onMessageSent={vi.fn()} models={models} pendingUserMessages={pending}
          onMessageSubmitted={message => setPending(current => [...current, message])} />}
      </>;
    }
    render(<SwitchingChat />);
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '待保留的提问' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '切换会话' }));
    fireEvent.click(screen.getByRole('button', { name: '切换会话' }));
    expect(screen.getByText('待保留的提问')).toBeTruthy();
  });
  it('subscribes to the thread so a running reply can be observed after navigation', () => {
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]} onMessageSent={vi.fn()}
      models={models} />);
    expect(chatOptions?.enableThreadSignals).toBe(true);
  });
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
  it('shows the selected conversation title in the top bar', () => {
    render(<AgentChat title="一个很长的会话标题" threadId="thread-1" resourceId="agent"
      initialMessages={[]} onMessageSent={vi.fn()} models={models} />);
    expect(screen.getByText('一个很长的会话标题')).toHaveProperty('title', '一个很长的会话标题');
    expect(screen.queryByText('智能体对话')).toBeNull();
  });
  it('uploads local files into composer cards and blocks send until ready', async () => {
    let finishUpload!: (value: {
      source: 'personal'; path: string; name: string; size: number; mimeType: string; etag: string;
    }) => void;
    uploadWorkspaceFile.mockImplementationOnce(() => new Promise(resolve => { finishUpload = resolve; }));
    const onFilesChanged = vi.fn();
    const { container } = render(<AgentChat threadId="thread-1" resourceId="agent"
      initialMessages={[]} onMessageSent={vi.fn()} models={models} onFilesChanged={onFilesChanged} />);
    const actions = container.querySelector('[data-slot="composer-actions"]')!;
    const add = screen.getByRole('button', { name: '添加附件' });
    expect(actions.contains(add)).toBe(true);
    fireEvent.click(add);
    fireEvent.click(screen.getByRole('menuitem', { name: '上传文件' }));
    const file = new File(['notes'], '报告 中文.md', { type: 'text/markdown' });
    fireEvent.change(screen.getByLabelText('选择本地文件'), { target: { files: [file] } });
    expect(screen.getByText('报告 中文.md')).toBeTruthy();
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '你好' } });
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    finishUpload({
      source: 'personal', path: 'uploads/u1/报告 中文.md', name: '报告 中文.md',
      size: 5, mimeType: 'text/markdown', etag: 'etag-1',
    });
    await waitFor(() => expect(screen.getByLabelText('附件 报告 中文.md')).toBeTruthy());
    expect(onFilesChanged).toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('dedupes workspace picks by path, retries failed uploads, and remove never deletes', async () => {
    listWorkspaceFiles.mockResolvedValue({
      files: [
        { path: 'docs', type: 'directory', size: 0 },
        { path: 'docs/a.txt', type: 'file', size: 3 },
        { path: 'docs/b.txt', type: 'file', size: 4 },
      ],
    });
    uploadWorkspaceFile
      .mockRejectedValueOnce(Object.assign(new Error('网络错误'), { code: 'UPLOAD_FAILED' }))
      .mockResolvedValueOnce({
        source: 'personal', path: 'uploads/u2/fail.txt', name: 'fail.txt',
        size: 4, mimeType: 'text/plain', etag: 'e2',
      });
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]}
      onMessageSent={vi.fn()} models={models} />);

    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '选择工作区文件' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '选择工作区文件' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '展开 docs' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 docs/a.txt' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 docs/b.txt' }));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(await screen.findByLabelText('附件 a.txt')).toBeTruthy();
    expect(screen.getByLabelText('附件 b.txt')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '选择工作区文件' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '选择工作区文件' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '展开 docs' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 docs/a.txt' }));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(screen.getAllByLabelText('附件 a.txt')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '上传文件' }));
    fireEvent.change(screen.getByLabelText('选择本地文件'), {
      target: { files: [new File(['x'], 'fail.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '重试 fail.txt' })).toBeTruthy());
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重试 fail.txt' }));
    await waitFor(() => expect(screen.getByLabelText('附件 fail.txt')).toBeTruthy());
    expect(uploadWorkspaceFile).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: '从本次消息移除 a.txt' }));
    expect(screen.queryByLabelText('附件 a.txt')).toBeNull();
    expect(screen.getByLabelText('附件 b.txt')).toBeTruthy();
  });

  it('rejects oversized browser uploads with feedback but does not call delete APIs on remove', async () => {
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]}
      onMessageSent={vi.fn()} models={models} />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '上传文件' }));
    const huge = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.bin', { type: 'application/octet-stream' });
    fireEvent.change(screen.getByLabelText('选择本地文件'), { target: { files: [huge] } });
    const hugeCard = await screen.findByLabelText('附件 huge.bin');
    expect(hugeCard.textContent).toMatch(/10 MiB/);
    expect(hugeCard.classList.contains('is-failed')).toBe(true);
    expect(uploadWorkspaceFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '从本次消息移除 huge.bin' }));
    expect(screen.queryByLabelText('附件 huge.bin')).toBeNull();
    expect(uploadWorkspaceFile).not.toHaveBeenCalled();
  });

  it('keeps oversize precheck feedback when another file in the same batch uploads', async () => {
    uploadWorkspaceFile.mockResolvedValue({
      source: 'personal', path: 'uploads/u3/ok.txt', name: 'ok.txt',
      size: 2, mimeType: 'text/plain', etag: 'e3',
    });
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]}
      onMessageSent={vi.fn()} models={models} />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '上传文件' }));
    const huge = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.bin', { type: 'application/octet-stream' });
    const ok = new File(['ok'], 'ok.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('选择本地文件'), { target: { files: [huge, ok] } });
    await waitFor(() => expect(screen.getByLabelText('附件 ok.txt')).toBeTruthy());
    const hugeCard = screen.getByLabelText('附件 huge.bin');
    expect(hugeCard.textContent).toMatch(/10 MiB/);
    expect(hugeCard.classList.contains('is-failed')).toBe(true);
    expect(uploadWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(uploadWorkspaceFile).toHaveBeenCalledWith(ok);
  });
  it('follows a growing streamed reply only while the reader is at the bottom', () => {
    const observers: Array<{ target: Element; notify: () => void }> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(private notify: () => void) {}
      observe(target: Element) { observers.push({ target, notify: this.notify }); }
      disconnect() {}
    });
    mockRunning = true;
    const { container } = render(<AgentChat threadId="thread-1" resourceId="agent"
      initialMessages={[]} onMessageSent={vi.fn()} models={models} />);
    const viewport = container.querySelector('[data-slot="message-scroller-viewport"]') as HTMLElement;
    const content = container.querySelector('[data-slot="message-scroller-content"]') as HTMLElement;
    let height = 600;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => height });
    const resized = () => observers.filter(item => item.target === content).forEach(item => item.notify());
    resized();
    expect(viewport.scrollTop).toBe(400);
    viewport.scrollTop = 100; fireEvent.scroll(viewport);
    height = 800; resized();
    expect(viewport.scrollTop).toBe(100);
    viewport.scrollTop = 600; fireEvent.scroll(viewport);
    height = 900; resized();
    expect(viewport.scrollTop).toBe(700);
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
