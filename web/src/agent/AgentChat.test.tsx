import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentChat } from './AgentChat';
import type { SafeModel } from './model-catalog-client';
import type { PendingUserMessage } from './pending-user-message';

const sendMessage = vi.fn();
const cancelRun = vi.fn();
const approveToolCall = vi.fn();
const uploadWorkspaceFile = vi.hoisted(() => vi.fn());
const listWorkspaceFiles = vi.hoisted(() => vi.fn());
const fetchWorkspaceFile = vi.hoisted(() => vi.fn());
const prepareAttachments = vi.hoisted(() => vi.fn());
const listThreadAttachments = vi.hoisted(() => vi.fn());
let chatOptions: { enableThreadSignals?: boolean } | undefined;
let mockRunning = false;
const chatRef = 'public:11111111-1111-4111-8111-111111111111' as const;
const memoryRef = 'private:22222222-2222-4222-8222-222222222222' as const;
const visionRef = 'public:33333333-3333-4333-8333-333333333333' as const;
const models = { chatModel: chatRef, memoryModel: memoryRef };
const catalog = [chatRef, memoryRef, visionRef].map((ref, index) => ({ ref,
  scope: index === 1 ? 'private' : 'public',
  displayName: index === 0 ? '默认模型' : index === 1 ? '个人模型' : '视觉模型',
  providerId: 'test', modelId: `m${index}`, baseUrl: 'https://example.test', apiMode: 'chat',
  enabled: true, hasApiKey: true, keyHint: '1234', supportsVision: index === 2,
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
  prepareAttachments: (...args: unknown[]) => prepareAttachments(...args),
  listThreadAttachments: (...args: unknown[]) => listThreadAttachments(...args),
}));
beforeEach(() => {
  listThreadAttachments.mockResolvedValue([]);
  fetchWorkspaceFile.mockResolvedValue(new Blob(['x'], { type: 'application/octet-stream' }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); mockRunning = false; mockMessages =
  [{ id: 'partial', role: 'assistant', content: { format: 2, parts: [{ type: 'text', text: '部分回复' }] } }];
});

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

  it('prepares attachments with the pending id and puts ids in the agent message', async () => {
    mockMessages = [];
    uploadWorkspaceFile.mockResolvedValue({
      source: 'personal', path: 'uploads/u1/notes.txt', name: 'notes.txt',
      size: 5, mimeType: 'text/plain', etag: 'e1',
    });
    prepareAttachments.mockResolvedValue([{
      attachmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      clientMessageId: 'ignored',
      source: 'personal', path: 'uploads/u1/notes.txt', name: 'notes.txt',
      size: 5, mimeType: 'text/plain', etag: 'e1', status: 'available',
    }]);
    sendMessage.mockResolvedValue(undefined);
    const submitted: PendingUserMessage[] = [];
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]}
      onMessageSent={vi.fn()} models={models} catalog={catalog}
      onMessageSubmitted={message => submitted.push(message)} />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '上传文件' }));
    fireEvent.change(screen.getByLabelText('选择本地文件'), {
      target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => expect(screen.getByLabelText('附件 notes.txt')).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '请阅读' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(prepareAttachments).toHaveBeenCalled());
    expect(submitted).toHaveLength(1);
    expect(prepareAttachments).toHaveBeenCalledWith('thread-1', submitted[0]!.id, [
      { source: 'personal', path: 'uploads/u1/notes.txt' },
    ]);
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const options = sendMessage.mock.calls[0]![0];
    expect(options.clientMessageId).toBe(submitted[0]!.id);
    expect(options.message).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(options.message).toContain('notes.txt');
    expect(submitted[0]!.text).toBe('请阅读');
    expect(submitted[0]!.text).not.toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('sends with default prompt when only ready attachments are present', async () => {
    mockMessages = [];
    listWorkspaceFiles.mockResolvedValue({
      files: [{ path: 'a.txt', type: 'file', size: 3 }],
    });
    prepareAttachments.mockResolvedValue([{
      attachmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      clientMessageId: 'x', source: 'personal', path: 'a.txt', name: 'a.txt',
      size: 3, mimeType: 'text/plain', etag: '', status: 'available',
    }]);
    sendMessage.mockResolvedValue(undefined);
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]}
      onMessageSent={vi.fn()} models={models} catalog={catalog} />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '选择工作区文件' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '选择工作区文件' })).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 a.txt' }));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(screen.getByLabelText('附件 a.txt')).toBeTruthy());
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0]![0].message).toContain('请查看附件');
    expect(sendMessage.mock.calls[0]![0].message).toContain('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  });

  it('blocks send when images are attached but the model lacks supportsVision', async () => {
    uploadWorkspaceFile.mockResolvedValue({
      source: 'personal', path: 'uploads/u1/shot.png', name: 'shot.png',
      size: 4, mimeType: 'image/png', etag: 'e1',
    });
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]}
      onMessageSent={vi.fn()} models={models} catalog={catalog} modelRef={chatRef} />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '添加图片' }));
    fireEvent.change(screen.getByLabelText('选择图片'), {
      target: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(screen.getByLabelText('附件 shot.png')).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '图里有什么' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(prepareAttachments).not.toHaveBeenCalled();
    expect(await screen.findByText(/当前模型不支持图片/)).toBeTruthy();
  });

  it('keeps draft and attachments when send fails after prepare', async () => {
    mockMessages = [];
    listWorkspaceFiles.mockResolvedValue({
      files: [{ path: 'a.txt', type: 'file', size: 3 }],
    });
    prepareAttachments.mockResolvedValue([{
      attachmentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      clientMessageId: 'x', source: 'personal', path: 'a.txt', name: 'a.txt',
      size: 3, mimeType: 'text/plain', etag: '', status: 'available',
    }]);
    sendMessage.mockRejectedValue(new Error('network down'));
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]}
      onMessageSent={vi.fn()} models={models} catalog={catalog} />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '选择工作区文件' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '选择工作区文件' })).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 a.txt' }));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(screen.getByLabelText('附件 a.txt')).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '草稿保留' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect((await screen.findByRole('alert')).textContent).toContain('network down');
    expect((screen.getByRole('textbox', { name: '发送消息' }) as HTMLTextAreaElement).value).toBe('草稿保留');
    expect(screen.getByLabelText('附件 a.txt')).toBeTruthy();
  });

  it('uploads OS file drops and only preventDefaults when files are present', async () => {
    uploadWorkspaceFile.mockResolvedValue({
      source: 'personal', path: 'uploads/u1/drop.md', name: 'drop.md',
      size: 4, mimeType: 'text/markdown', etag: 'e1',
    });
    const { container } = render(<AgentChat threadId="thread-1" resourceId="agent"
      initialMessages={[]} onMessageSent={vi.fn()} models={models} />);
    const composer = container.querySelector('.agent-composer')!;
    const emptyDrag = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(emptyDrag, 'dataTransfer', { value: { types: ['text/plain'] } });
    composer.dispatchEvent(emptyDrag);
    expect(emptyDrag.defaultPrevented).toBe(false);

    const fileDrag = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(fileDrag, 'dataTransfer', { value: { types: ['Files'] } });
    composer.dispatchEvent(fileDrag);
    expect(fileDrag.defaultPrevented).toBe(true);

    const drop = new Event('drop', { bubbles: true, cancelable: true });
    const file = new File(['drop'], 'drop.md', { type: 'text/markdown' });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { types: ['Files'], files: [file], getData: () => '' },
    });
    composer.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await waitFor(() => expect(uploadWorkspaceFile).toHaveBeenCalledWith(file));
    await waitFor(() => expect(screen.getByLabelText('附件 drop.md')).toBeTruthy());
  });

  it('routes OS image drops through image upload kind for image cards', async () => {
    uploadWorkspaceFile.mockResolvedValue({
      source: 'personal', path: 'uploads/u1/shot.png', name: 'shot.png',
      size: 4, mimeType: 'image/png', etag: 'e1',
    });
    fetchWorkspaceFile.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:drop-shot', revokeObjectURL: vi.fn() });
    const { container } = render(<AgentChat threadId="thread-1" resourceId="agent"
      initialMessages={[]} onMessageSent={vi.fn()} models={models} catalog={catalog} modelRef={visionRef} />);
    const composer = container.querySelector('.agent-composer')!;
    const image = new File(['img'], 'shot.png', { type: 'image/png' });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { types: ['Files'], files: [image], getData: () => '' },
    });
    composer.dispatchEvent(drop);
    await waitFor(() => expect(uploadWorkspaceFile).toHaveBeenCalledWith(image));
    const card = await screen.findByLabelText('附件 shot.png');
    expect(card.querySelector('img')).toBeTruthy();
  });

  it('references workspace drag items without uploading and pastes clipboard images', async () => {
    uploadWorkspaceFile.mockResolvedValue({
      source: 'personal', path: 'uploads/u1/paste.png', name: 'paste.png',
      size: 4, mimeType: 'image/png', etag: 'e1',
    });
    listWorkspaceFiles.mockResolvedValue({
      files: [{ path: 'docs/ref.txt', type: 'file', size: 3 }],
    });
    const { container } = render(<AgentChat threadId="thread-1" resourceId="agent"
      initialMessages={[]} onMessageSent={vi.fn()} models={models} catalog={catalog} modelRef={visionRef} />);
    const composer = container.querySelector('.agent-composer')!;
    const workspaceDrop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(workspaceDrop, 'dataTransfer', {
      value: {
        types: ['application/x-nero-workspace-file'],
        files: [],
        getData: (type: string) => type === 'application/x-nero-workspace-file'
          ? JSON.stringify({ source: 'personal', path: 'docs/ref.txt', name: 'ref.txt', size: 3, mimeType: 'text/plain' })
          : '',
      },
    });
    composer.dispatchEvent(workspaceDrop);
    await waitFor(() => expect(screen.getByLabelText('附件 ref.txt')).toBeTruthy());
    expect(uploadWorkspaceFile).not.toHaveBeenCalled();

    const paste = new Event('paste', { bubbles: true, cancelable: true });
    const image = new File(['img'], 'paste.png', { type: 'image/png' });
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [{ type: 'image/png', kind: 'file', getAsFile: () => image }] },
    });
    composer.dispatchEvent(paste);
    await waitFor(() => expect(uploadWorkspaceFile).toHaveBeenCalledWith(image));
  });

  it('loads thread attachments for history cards after refresh by attachment ids in text', async () => {
    listThreadAttachments.mockResolvedValue([{
      attachmentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      clientMessageId: 'prepare-client-id',
      source: 'personal', path: 'docs/hist.txt', name: 'hist.txt',
      size: 4, mimeType: 'text/plain', etag: 'e1', status: 'available',
    }]);
    // Production: Mastra renames message.id (client-set-*) and strips metadata.clientMessageId on reload.
    mockMessages = [{
      id: 'client-set-renamed', role: 'user',
      content: { format: 2, parts: [{ type: 'text', text: [
        '历史提问',
        '',
        '[[nero-attachments]]',
        'id=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee|name=hist.txt|mime=text/plain',
        '[[/nero-attachments]]',
        '',
        '请使用 read_attached_file({ attachmentId }) 读取以上附件。',
      ].join('\n') }] },
    }];
    render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={mockMessages as never}
      onMessageSent={vi.fn()} models={models} />);
    await waitFor(() => expect(listThreadAttachments).toHaveBeenCalledWith(
      'thread-1', expect.any(AbortSignal)));
    expect(await screen.findByLabelText('附件 hist.txt')).toBeTruthy();
    expect(screen.getByText('历史提问')).toBeTruthy();
    expect(screen.queryByText(/nero-attachments/)).toBeNull();
  });

  it('does not let a stale attachment list overwrite prepare results', async () => {
    mockMessages = [];
    let resolveList!: (items: unknown[]) => void;
    listThreadAttachments.mockImplementation(() => new Promise(resolve => { resolveList = resolve; }));
    listWorkspaceFiles.mockResolvedValue({
      files: [{ path: 'a.txt', type: 'file', size: 3 }],
    });
    prepareAttachments.mockResolvedValue([{
      attachmentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      clientMessageId: 'prepare-client-id',
      source: 'personal', path: 'a.txt', name: 'a.txt',
      size: 3, mimeType: 'text/plain', etag: '', status: 'available',
    }]);
    sendMessage.mockResolvedValue(undefined);
    const { rerender } = render(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]}
      onMessageSent={vi.fn()} models={models} catalog={catalog} />);
    await waitFor(() => expect(listThreadAttachments).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '选择工作区文件' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '选择工作区文件' })).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 a.txt' }));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(screen.getByLabelText('附件 a.txt')).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '请阅读' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(prepareAttachments).toHaveBeenCalled());
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const agentText = sendMessage.mock.calls[0]![0].message as string;
    mockMessages = [{
      id: 'client-set-not-pending', role: 'user',
      content: { format: 2, parts: [{ type: 'text', text: agentText }] },
    }];
    rerender(<AgentChat threadId="thread-1" resourceId="agent" initialMessages={[]}
      onMessageSent={vi.fn()} models={models} catalog={catalog} />);
    expect(await screen.findByLabelText('附件 a.txt')).toBeTruthy();
    // Stale mount-time list returns empty after prepare — must not wipe cards.
    resolveList([]);
    await waitFor(() => expect(screen.getByLabelText('附件 a.txt')).toBeTruthy());
  });

  it('keeps existing history cards when attachment list refresh fails', async () => {
    listThreadAttachments
      .mockResolvedValueOnce([{
        attachmentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        clientMessageId: 'prepare-client-id',
        source: 'personal', path: 'docs/hist.txt', name: 'hist.txt',
        size: 4, mimeType: 'text/plain', etag: 'e1', status: 'available',
      }])
      .mockRejectedValueOnce(new Error('temporary network blip'));
    mockMessages = [{
      id: 'client-set-renamed', role: 'user',
      content: { format: 2, parts: [{ type: 'text', text: [
        '历史提问',
        '',
        '[[nero-attachments]]',
        'id=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee|name=hist.txt|mime=text/plain',
        '[[/nero-attachments]]',
      ].join('\n') }] },
    }];
    const { rerender } = render(<AgentChat threadId="thread-1" resourceId="agent"
      initialMessages={mockMessages as never} onMessageSent={vi.fn()} models={models} />);
    expect(await screen.findByLabelText('附件 hist.txt')).toBeTruthy();
    mockRunning = true;
    rerender(<AgentChat threadId="thread-1" resourceId="agent"
      initialMessages={mockMessages as never} onMessageSent={vi.fn()} models={models} />);
    mockRunning = false;
    rerender(<AgentChat threadId="thread-1" resourceId="agent"
      initialMessages={mockMessages as never} onMessageSent={vi.fn()} models={models} />);
    await waitFor(() => expect(listThreadAttachments).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('附件 hist.txt')).toBeTruthy();
  });

  it('consumes incremental attach requests from the page without repeating them', async () => {
    listWorkspaceFiles.mockResolvedValue({
      files: [
        { path: 'docs/a.txt', type: 'file', size: 3 },
        { path: 'docs/b.txt', type: 'file', size: 4 },
      ],
    });
    const { rerender } = render(<AgentChat threadId="thread-1" resourceId="agent"
      initialMessages={[]} onMessageSent={vi.fn()} models={models}
      attachRequest={{ id: 1, path: 'docs/a.txt', source: 'personal' }} />);
    expect(await screen.findByLabelText('附件 a.txt')).toBeTruthy();
    rerender(<AgentChat threadId="thread-1" resourceId="agent"
      initialMessages={[]} onMessageSent={vi.fn()} models={models}
      attachRequest={{ id: 1, path: 'docs/a.txt', source: 'personal' }} />);
    expect(screen.getAllByLabelText('附件 a.txt')).toHaveLength(1);
    rerender(<AgentChat threadId="thread-1" resourceId="agent"
      initialMessages={[]} onMessageSent={vi.fn()} models={models}
      attachRequest={{ id: 2, path: 'docs/b.txt', source: 'personal' }} />);
    expect(await screen.findByLabelText('附件 b.txt')).toBeTruthy();
  });
});
