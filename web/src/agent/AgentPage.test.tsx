import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPage } from './AgentPage';
import { AgentShell } from './AgentShell';
import type { PendingUserMessage } from './pending-user-message';

const testUser = { id: 'agent', email: 'test@example.com', displayName: 'Test', roles: ['user'] as Array<'user' | 'admin'> };

const flash = 'public:11111111-1111-4111-8111-111111111111';
const pro = 'public:22222222-2222-4222-8222-222222222222';
const mine = 'private:33333333-3333-4333-8333-333333333333';
const update = vi.fn();
const get = vi.fn();
const listMessages = vi.fn();
const getSelectableModels = vi.fn();
const createThread = vi.fn();
const deleteThread = vi.fn();
const previewFirstMessageTitle = vi.fn();
const confirmFirstMessageTitle = vi.fn();
const discardFirstMessageTitle = vi.fn();
let threadItems: Array<{ id: string; title: string; resourceId: string; updatedAt: string }> = [];
const listAgentsModelProviders = vi.fn();
const model = (ref: string, modelId: string, extra = {}) => ({ ref, scope: 'public', displayName: modelId,
  providerId: 'deepseek', modelId, baseUrl: 'https://api.example.com', apiMode: 'chat', enabled: true,
  hasApiKey: true, keyHint: '1234', supportsVision: false, ...extra });

vi.mock('./client', () => ({ AGENT_ID: 'agent', getFinanceCapabilities: async () => ({ enabled: false, categories: [] }), client: {
  getAgent: () => ({ details: () => Promise.resolve({ name: '智能体', modelId: 'openai/gpt-5.6-terra', tools: {} }) }),
  getMemoryConfig: () => Promise.resolve({ config: { observationalMemory: { observationModel: 'deepseek/deepseek-v4-flash' } } }),
  listAgentsModelProviders: () => listAgentsModelProviders(),
  getMemoryThread: () => ({ get, listMessages, update }),
}, listUserFiles: async (threadId: string) => {
  const response = await fetch(`/user-files/${threadId}`);
  return (await response.json() as { files: unknown[] }).files;
}, listWorkspaceFiles: async () => {
  const response = await fetch('/current-workspace/files');
  const body = await response.json() as { files: unknown[]; usage?: unknown };
  return { files: body.files, usage: body.usage };
}, deleteWorkspaceFiles: async (paths: string[]) => {
  const response = await fetch('/current-workspace/files/batch-delete', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }),
  });
  return response.json();
} }));
vi.mock('./model-catalog-client', () => ({ getSelectableModels: () => getSelectableModels() }));
const refreshThreadList = vi.fn();
vi.mock('./use-thread-list', () => ({ useThreadList: () => ({
  threads: threadItems, loading: false, error: null, refresh: refreshThreadList, createThread, deleteThread,
  renameThread: vi.fn(),
  previewFirstMessageTitle, confirmFirstMessageTitle, discardFirstMessageTitle,
}) }));
const ensureRecent = vi.fn();
const invalidateThread = vi.fn();
vi.mock('./use-history-search', () => ({
  useHistorySearch: () => ({
    documents: [{
      threadId: 'thread/special',
      threadTitle: 'T',
      threadUpdatedAt: '2026-10-11T00:00:00.000Z',
      userMessageId: 'msg?id=1',
      questionText: 'find me',
      answerText: 'ok',
    }],
    scope: 'recent',
    recentStatus: 'ready',
    fullStatus: 'idle',
    recentProgress: { completed: 1, total: 1 },
    fullProgress: { completed: 0, total: 0 },
    recentFailedCount: 0,
    fullFailedCount: 0,
    ensureRecent,
    cancelRecent: vi.fn(),
    loadAll: vi.fn(),
    retryRecent: vi.fn(),
    retryFull: vi.fn(),
    invalidateThread,
  }),
}));
vi.mock('./history-search-cache', () => ({ createHistorySearchCache: () => ({}) }));
vi.mock('./AgentChat', () => ({ AgentChat: ({ title, models, sendBlockedReason, catalog, modelRef, onModelChange,
  modelError, pendingUserMessages, onMessageSubmitted, onMessageSent, onMessageFailed, onResponseSettled,
  onFilesChanged, attachRequest, attachmentRefreshVersion,
  targetMessageId, initialDraft, focusComposer, sendOnMount, initialFiles, scheduledRun }: {
  title?: string;
  initialDraft?: string; focusComposer?: boolean; sendOnMount?: boolean;
  initialFiles?: { files: File[]; kind: 'file' | 'image' }[];
  models: { chatModel: string; memoryModel: string } | null; sendBlockedReason?: string | null;
  catalog?: Array<{ ref: string; displayName: string }>; modelRef?: string; onModelChange?: (ref: string) => void;
  modelError?: string | null; pendingUserMessages?: PendingUserMessage[];
  onMessageSubmitted?: (message: PendingUserMessage) => void;
  onMessageSent?: (message: PendingUserMessage) => void;
  onMessageFailed?: (message: PendingUserMessage) => void;
  onResponseSettled?: () => void;
  onFilesChanged?: () => void;
  attachRequest?: { id: number; path: string; source: 'personal' | 'agent' } | null;
  attachmentRefreshVersion?: number;
  targetMessageId?: string;
  scheduledRun?: { taskId: string; runId: string } | null;
}) => <div data-testid="models">{models ? `${models.chatModel}|${models.memoryModel}` : 'none'}
  <textarea aria-label="已创建会话输入框" defaultValue={initialDraft} autoFocus={focusComposer} />
  <span data-testid="chat-title">{title}</span>
  <span data-testid="blocked">{sendBlockedReason ?? ''}</span>
  <span data-testid="pending">{pendingUserMessages?.map(message => message.text).join('|')}</span>
  <span data-testid="attach-request">{attachRequest
    ? `${attachRequest.id}|${attachRequest.source}|${attachRequest.path}` : ''}</span>
  <span data-testid="attachment-refresh">{String(attachmentRefreshVersion ?? 0)}</span>
  <span data-testid="target-message">{targetMessageId ?? ''}</span>
  <span data-testid="scheduled-run">{scheduledRun ? `${scheduledRun.taskId}|${scheduledRun.runId}` : ''}</span>
  <span data-testid="auto-send">{String(Boolean(sendOnMount))}</span>
  <span data-testid="handoff-files">{initialFiles?.flatMap(batch => batch.files.map(file => file.name)).join('|')}</span>
  <button type="button" onClick={() => onMessageSubmitted?.({ id: 'local', text: '刚发送的消息',
    createdAt: new Date(), occurrence: 1 })}>模拟发送</button>
  <button type="button" onClick={() => onMessageSent?.({ id: 'local', text: '刚发送的消息',
    createdAt: new Date(), occurrence: 1 })}>模拟发送成功</button>
  <button type="button" onClick={() => onMessageFailed?.({ id: 'local', text: '失败的消息',
    createdAt: new Date(), occurrence: 1 })}>模拟发送失败</button>
  <button type="button" onClick={() => onResponseSettled?.()}>模拟回复结束</button>
  <button type="button" onClick={() => onFilesChanged?.()}>模拟文件生成</button>
  {modelError && <span role="alert">{modelError}</span>}
  <select aria-label="模型" value={modelRef ?? ''} onChange={event => onModelChange?.(event.target.value)}>
    <option value="">选择模型</option>
    {catalog?.map(item => <option key={item.ref} value={item.ref}>{item.displayName}</option>)}
  </select></div> }));

function threadWith(models: unknown) {
  get.mockResolvedValue({ id: 'thread-1', resourceId: 'agent', metadata: { other: 'preserve', neroAgentModels: models } });
}

beforeEach(() => {
  localStorage.clear();
  threadItems = [];
  deleteThread.mockResolvedValue(undefined);
  getSelectableModels.mockResolvedValue([model(flash, '默认模型', { isDefault: true }), model(pro, 'Pro')]);
  threadWith({ chatModel: flash, memoryModel: flash });
  listMessages.mockResolvedValue({ messages: [], hasMore: false });
  update.mockResolvedValue({});
  confirmFirstMessageTitle.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals();
  document.documentElement.classList.remove('light'); });

function renderPage(path = '/agent/thread-1') {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route element={<AgentShell user={testUser} onLogout={vi.fn()} />}>
      <Route path="/agent/:threadId" element={<AgentPage />} />
    </Route>
  </Routes></MemoryRouter>);
}

describe('Agent page model selection', () => {
  it('shows the mobile Inbox with overview cards and recent conversations at narrow widths', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 767px)', media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    threadItems = [{ id: 'thread-1', title: '移动端会话', resourceId: 'agent', updatedAt: '2026-10-16T00:00:00Z' }];
    renderPage('/agent/new');
    expect(await screen.findByRole('region', { name: 'Inbox' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '历史对话，1 个会话' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '文件管理' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '模型列表' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '敬请期待' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '打开会话 移动端会话' })).toBeTruthy();
  });
  it('shows a mobile back control for an open conversation', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 767px)', media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    renderPage('/agent/thread-1');
    expect(await screen.findByRole('button', { name: '返回 Inbox' })).toBeTruthy();
  });
  it('types directly in the mobile composer without creating a thread until send', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 767px)', media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    createThread.mockResolvedValueOnce({ id: 'thread-1' });
    renderPage('/agent/new');
    const input = await screen.findByRole('textbox', { name: '发送消息' });
    fireEvent.focus(input);
    expect(createThread).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '请总结今天的内容' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(createThread).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole('textbox', { name: '已创建会话输入框' }) as HTMLTextAreaElement).value)
      .toBe('请总结今天的内容');
    expect(screen.getByTestId('auto-send').textContent).toBe('true');
  });
  it('passes a file selected from the mobile plus menu into the created conversation', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 767px)', media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    createThread.mockResolvedValueOnce({ id: 'thread-1' });
    const { container } = renderPage('/agent/new');
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '上传文件' }));
    const fileInput = container.querySelector('input[aria-label="选择本地文件"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(createThread).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId('handoff-files')).textContent).toBe('notes.txt');
  });
  it('passes a scheduled run identity to the open conversation', async () => {
    get.mockResolvedValue({ id: 'thread-1', resourceId: 'agent', metadata: {
      neroAgentSourceType: 'schedule', neroAgentScheduleTaskId: 'task-1',
      neroAgentScheduleRunId: 'run-1', neroAgentModels: { chatModel: flash, memoryModel: flash },
    } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('scheduled-run').textContent).toBe('task-1|run-1'));
  });
  it('refreshes scheduled conversations on tab switch, while visible, and after returning to the page', () => {
    vi.useFakeTimers();
    try {
      renderPage('/agent/new');
      fireEvent.click(screen.getByRole('tab', { name: '调度' }));
      expect(refreshThreadList).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(15_000); });
      expect(refreshThreadList).toHaveBeenCalledTimes(2);
      fireEvent(document, new Event('visibilitychange'));
      expect(refreshThreadList).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the new-conversation welcome and composer without creating a thread on page load', async () => {
    renderPage('/agent/new');
    expect(await screen.findByRole('heading', { name: '有什么可以帮你？' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '发送消息' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '添加附件' }) as HTMLButtonElement).disabled).toBe(true);
    expect(createThread).not.toHaveBeenCalled();
  });
  it('creates once on composer focus and transfers typed draft and focus into the new conversation', async () => {
    let resolveCreate!: (thread: { id: string }) => void;
    createThread.mockImplementationOnce(() => new Promise(resolve => { resolveCreate = resolve; }));
    renderPage('/agent/new');
    const input = screen.getByRole('textbox', { name: '发送消息' }) as HTMLTextAreaElement;
    await waitFor(() => expect(screen.getByRole('combobox', { name: '模型' }).textContent)
      .toContain('默认模型'));

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '创建期间输入的问题' } });
    fireEvent.focus(input);
    expect(createThread).toHaveBeenCalledTimes(1);
    resolveCreate({ id: 'thread-1' });

    const createdInput = await screen.findByRole('textbox', { name: '已创建会话输入框' }) as HTMLTextAreaElement;
    expect(createdInput.value).toBe('创建期间输入的问题');
    expect(document.activeElement).toBe(createdInput);
  });
  it('keeps the landing draft after creation fails and retries when the composer is focused again', async () => {
    createThread.mockRejectedValueOnce(new Error('网络断开')).mockResolvedValueOnce({ id: 'thread-1' });
    renderPage('/agent/new');
    const input = screen.getByRole('textbox', { name: '发送消息' }) as HTMLTextAreaElement;
    await waitFor(() => expect(screen.getByRole('combobox', { name: '模型' }).textContent)
      .toContain('默认模型'));

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '请帮我检查' } });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '网络断开');
    expect(input.value).toBe('请帮我检查');

    fireEvent.blur(input);
    fireEvent.focus(input);
    await waitFor(() => expect(createThread).toHaveBeenCalledTimes(2));
    const createdInput = await screen.findByRole('textbox', { name: '已创建会话输入框' }) as HTMLTextAreaElement;
    expect(createdInput.value).toBe('请帮我检查');
  });
  it('does not offer attaching a workspace file before a conversation exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ files: [
      { path: 'docs', type: 'directory', size: 3 },
      { path: 'docs/a.txt', type: 'file', size: 3 },
    ] }), { status: 200 })));
    renderPage('/agent/new');
    fireEvent.click(screen.getByRole('button', { name: '打开文件管理面板' }));
    fireEvent.click(await screen.findByRole('button', { name: '展开 docs' }));
    fireEvent.click(screen.getByRole('button', { name: 'docs/a.txt 的更多操作' }));
    expect(screen.queryByRole('menuitem', { name: '加入当前对话' })).toBeNull();
  });
  it('holds the selected model steady while the focused composer creates its conversation', async () => {
    let resolveCreate!: (thread: { id: string }) => void;
    createThread.mockImplementationOnce(() => new Promise(resolve => { resolveCreate = resolve; }));
    renderPage('/agent/new');
    const modelSelect = screen.getByRole('combobox', { name: '模型' }) as HTMLButtonElement;
    await waitFor(() => expect(modelSelect.textContent).toContain('默认模型'));
    fireEvent.focus(screen.getByRole('textbox', { name: '发送消息' }));
    expect(modelSelect.disabled).toBe(true);
    resolveCreate({ id: 'thread-1' });
  });
  it('keeps the landing draft when retrying a failed creation from the sidebar', async () => {
    createThread.mockRejectedValueOnce(new Error('网络断开')).mockResolvedValueOnce({ id: 'thread-1' });
    renderPage('/agent/new');
    const input = screen.getByRole('textbox', { name: '发送消息' }) as HTMLTextAreaElement;
    await waitFor(() => expect(screen.getByRole('combobox', { name: '模型' }).textContent)
      .toContain('默认模型'));
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '还没发送的草稿' } });
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    const createdInput = await screen.findByRole('textbox', { name: '已创建会话输入框' }) as HTMLTextAreaElement;
    expect(createdInput.value).toBe('还没发送的草稿');
    expect(document.activeElement).toBe(createdInput);
  });
  it('connects both bounded resize handles to the page layout', () => {
    const { container } = renderPage();
    const left = screen.getByRole('separator', { name: '调整左侧面板宽度' });
    fireEvent.click(screen.getByRole('button', { name: '打开 Config 面板' }));
    const right = screen.getByRole('separator', { name: '调整右侧面板宽度' });
    fireEvent.keyDown(left, { key: 'End' });
    expect((container.querySelector('.agent-layout') as HTMLElement).style.getPropertyValue('--left-panel-width'))
      .toBe('420px');
    fireEvent.keyDown(right, { key: 'End' });
    expect(right.getAttribute('aria-valuenow')).toBe('620');
  });
  it('restores chosen widths after a narrow viewport is widened again', () => {
    vi.stubGlobal('innerWidth', 1400);
    const { container } = renderPage();
    const left = screen.getByRole('separator', { name: '调整左侧面板宽度' });
    fireEvent.click(screen.getByRole('button', { name: '打开 Config 面板' }));
    const right = screen.getByRole('separator', { name: '调整右侧面板宽度' });
    fireEvent.keyDown(left, { key: 'End' });
    fireEvent.keyDown(right, { key: 'End' });
    vi.stubGlobal('innerWidth', 1051);
    fireEvent(window, new Event('resize'));
    expect((container.querySelector('.agent-layout') as HTMLElement).style.getPropertyValue('--left-panel-width'))
      .not.toBe('420px');
    vi.stubGlobal('innerWidth', 1400);
    fireEvent(window, new Event('resize'));
    expect((container.querySelector('.agent-layout') as HTMLElement).style.getPropertyValue('--left-panel-width'))
      .toBe('420px');
    expect(right.getAttribute('aria-valuenow')).toBe('620');
  });
  it('passes the selected sidebar title to the conversation header', async () => {
    threadItems = [{ id: 'thread-1', title: '和左侧一致的会话标题', resourceId: 'agent', updatedAt: '' }];
    renderPage();
    expect(await screen.findByTestId('chat-title')).toHaveProperty('textContent', '和左侧一致的会话标题');
  });
  it('updates the workspace file list after the conversation creates a file', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [
        { path: 'threads', type: 'directory', size: 0 },
        { path: 'threads/thread-1', type: 'directory', size: 0 },
        { path: 'threads/thread-1/output', type: 'directory', size: 0 },
        { path: 'threads/thread-1/output/result.md', type: 'file', size: 5 },
      ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '打开文件管理面板' }));
    await screen.findByText('暂无文件');
    fireEvent.click(screen.getByRole('button', { name: '模拟文件生成' }));
    fireEvent.click(await screen.findByRole('button', { name: '展开 threads' }));
    fireEvent.click(screen.getByRole('button', { name: '展开 threads/thread-1' }));
    fireEvent.click(screen.getByRole('button', { name: '展开 threads/thread-1/output' }));
    expect(await screen.findByRole('button', { name: '打开 threads/thread-1/output/result.md' })).toBeTruthy();
  });
  it('keeps a just-submitted bubble across history navigation while history is stale', async () => {
    threadItems = [
      { id: 'thread-1', title: '第一条', resourceId: 'agent', updatedAt: '2026-10-05' },
      { id: 'thread-2', title: '第二条', resourceId: 'agent', updatedAt: '2026-10-04' },
    ];
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '模拟发送' }));
    expect(previewFirstMessageTitle).toHaveBeenCalledWith('thread-1', '刚发送的消息');
    expect(screen.getByTestId('pending').textContent).toBe('刚发送的消息');
    fireEvent.click(screen.getByRole('button', { name: '第二条' }));
    await waitFor(() => expect(screen.getByTestId('pending').textContent).toBe(''));
    fireEvent.click(screen.getByRole('button', { name: '第一条' }));
    await waitFor(() => expect(screen.getByTestId('pending').textContent).toBe('刚发送的消息'));
  });
  it('keeps the submitted bubble when navigating through a new conversation', async () => {
    threadItems = [{ id: 'thread-1', title: '第一条', resourceId: 'agent', updatedAt: '2026-10-05' }];
    createThread.mockResolvedValue({ id: 'thread-2' });
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '模拟发送' }));
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    await waitFor(() => expect(createThread).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '第一条' }));
    await waitFor(() => expect(screen.getByTestId('pending').textContent).toBe('刚发送的消息'));
  });
  it('navigates to the next visible conversation after a confirmed delete', async () => {
    threadItems = [
      { id: 'thread-1', title: '第一条', resourceId: 'agent', updatedAt: '2026-10-05' },
      { id: 'thread-2', title: '第二条', resourceId: 'agent', updatedAt: '2026-10-04' },
    ];
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '第一条 的更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除会话' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteThread).toHaveBeenCalledWith('thread-1'));
    await waitFor(() => expect(screen.getByRole('button', { name: '第二条' }).getAttribute('aria-current')).toBe('page'));
  });
  it('shows the new conversation page after deleting the only conversation', async () => {
    threadItems = [{ id: 'thread-1', title: '唯一会话', resourceId: 'agent', updatedAt: '2026-10-05' }];
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '唯一会话 的更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除会话' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteThread).toHaveBeenCalledWith('thread-1'));
    expect(await screen.findByRole('heading', { name: '有什么可以帮你？' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '发送消息' })).toBeTruthy();
  });
  it('starts with the public default and saves a Composer choice for chat and memory', async () => {
    threadWith(undefined);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('models').textContent).toContain(`${flash}|${flash}`));
    const select = screen.getByRole('combobox', { name: '模型' }) as HTMLSelectElement;
    expect(select.value).toBe(flash);
    fireEvent.change(select, { target: { value: pro } });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ metadata: {
      other: 'preserve', neroAgentModels: { chatModel: pro, memoryModel: pro },
    } }));
    expect(screen.getByTestId('models').textContent).toContain(`${pro}|${pro}`);
  });

  it('uses catalog entries, including selectable private models, without exposing their configuration', async () => {
    vi.stubEnv('VITE_AGENT_MODEL', 'openai/env-only-model');
    try {
      getSelectableModels.mockResolvedValue([model(flash, '默认模型', { isDefault: true }),
        model(mine, '个人模型', { scope: 'private' })]);
      renderPage();
      await waitFor(() => expect(screen.getByTestId('models').textContent).toContain(`${flash}|${flash}`));
      const select = screen.getByRole('combobox', { name: '模型' });
      expect(within(select).getAllByRole('option').map(option => option.getAttribute('value')))
        .toEqual(['', flash, mine]);
      expect(listAgentsModelProviders).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '管理' }));
      expect(screen.queryByRole('button', { name: 'API Key 管理' })).toBeNull();
      expect(screen.queryByRole('combobox', { name: '会话模型' })).toBeNull();
    } finally { vi.unstubAllEnvs(); }
  });

  it('rejects a forged provider/model selection', async () => {
    renderPage();
    await screen.findByTestId('models');
    const select = screen.getByRole('combobox', { name: '模型' });
    const forged = document.createElement('option');
    forged.value = 'openai/gpt-5.6-terra'; forged.textContent = 'forged';
    select.appendChild(forged);
    fireEvent.change(select, { target: { value: forged.value } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('模型'));
    expect(update).not.toHaveBeenCalled();
  });

  it('maps a saved legacy model and prompts for a missing selection', async () => {
    threadWith({ chatModel: 'deepseek/默认模型', memoryModel: 'deepseek/默认模型' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('models').textContent).toContain(`${flash}|${flash}`));
  });

  it('lets the user repair a missing model in Composer', async () => {
    threadWith({ chatModel: 'openai/gone', memoryModel: flash });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('blocked').textContent).toContain('不可用'));
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: pro } });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ metadata: {
      other: 'preserve', neroAgentModels: { chatModel: pro, memoryModel: pro },
    } }));
  });

  it('allows reselecting the same chat model when only its saved memory model is missing', async () => {
    threadWith({ chatModel: flash, memoryModel: 'private:99999999-9999-4999-8999-999999999999' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('blocked').textContent).toContain('不可用'));
    const select = screen.getByRole('combobox', { name: '模型' }) as HTMLSelectElement;
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: flash } });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ metadata: {
      other: 'preserve', neroAgentModels: { chatModel: flash, memoryModel: flash },
    } }));
  });

  it('requires a public default to create a new conversation', async () => {
    getSelectableModels.mockResolvedValue([model(pro, '普通模型')]);
    renderPage('/agent/new');
    await waitFor(() => expect(getSelectableModels).toHaveBeenCalled());
    expect(screen.getAllByRole('button', { name: /新建会话/ }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(createThread).not.toHaveBeenCalled();
  });

  it('keeps theme switching in Manage', async () => {
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '外观' }));
    fireEvent.click(screen.getByRole('button', { name: '浅色' }));
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('passes incremental attach requests to the active chat', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ files: [
      { path: 'docs', type: 'directory', size: 0 },
      { path: 'docs/a.txt', type: 'file', size: 3 },
      { path: 'docs/b.txt', type: 'file', size: 4 },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '打开文件管理面板' }));
    fireEvent.click(await screen.findByRole('button', { name: '展开 docs' }));
    fireEvent.click(screen.getByRole('button', { name: 'docs/a.txt 的更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '加入当前对话' }));
    await waitFor(() => expect(screen.getByTestId('attach-request').textContent)
      .toBe('1|personal|docs/a.txt'));
    fireEvent.click(screen.getByRole('button', { name: 'docs/b.txt 的更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '加入当前对话' }));
    await waitFor(() => expect(screen.getByTestId('attach-request').textContent)
      .toBe('2|personal|docs/b.txt'));
  });

  it('does not replay an attachment request into another conversation', async () => {
    threadItems = [
      { id: 'thread-1', title: '第一条', resourceId: 'agent', updatedAt: '2026-10-05' },
      { id: 'thread-2', title: '第二条', resourceId: 'agent', updatedAt: '2026-10-04' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ files: [
      { path: 'docs', type: 'directory', size: 3 },
      { path: 'docs/a.txt', type: 'file', size: 3 },
    ] }), { status: 200 })));
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '打开文件管理面板' }));
    fireEvent.click(await screen.findByRole('button', { name: '展开 docs' }));
    fireEvent.click(screen.getByRole('button', { name: 'docs/a.txt 的更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '加入当前对话' }));
    expect(screen.getByTestId('attach-request').textContent).toBe('1|personal|docs/a.txt');

    fireEvent.click(screen.getByRole('button', { name: '第二条' }));
    await waitFor(() => expect(screen.getByTestId('chat-title').textContent).toBe('第二条'));
    expect(screen.getByTestId('attach-request').textContent).toBe('');
  });

  it('shows personal usage and refreshes after a workspace file delete', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [
          { path: 'docs', type: 'directory', size: 3 },
          { path: 'docs/a.txt', type: 'file', size: 3 },
        ],
        usage: { usedBytes: 3, quotaBytes: 500 * 1024 * 1024, fileCount: 1 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ path: 'docs/a.txt', ok: true }],
        deletedFiles: 1,
        freedBytes: 3,
        usage: { usedBytes: 0, quotaBytes: 500 * 1024 * 1024, fileCount: 0 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [{ path: 'docs', type: 'directory', size: 0 }],
        usage: { usedBytes: 0, quotaBytes: 500 * 1024 * 1024, fileCount: 0 },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '打开文件管理面板' }));
    expect(await screen.findByText(/已用 3 B \/ 500 MiB/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '展开 docs' }));
    fireEvent.click(screen.getByRole('button', { name: 'docs/a.txt 的更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '确认删除' }))
      .getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/current-workspace/files/batch-delete',
      expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText(/已用 0 B \/ 500 MiB/)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('attachment-refresh').textContent).not.toBe('0'));
  });
});

describe('history search', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });
  it('passes targetMessageId from the query string into AgentChat', async () => {
    threadItems = [{ id: 'thread-1', title: '当前', resourceId: 'agent', updatedAt: '2026-10-11' }];
    renderPage('/agent/thread-1?targetMessageId=msg%3Fid%3D1');
    await screen.findByTestId('models');
    expect(screen.getByTestId('target-message').textContent).toBe('msg?id=1');
  });
  it('invalidates history search after a successful message send', async () => {
    threadItems = [{ id: 'thread-1', title: '当前', resourceId: 'agent', updatedAt: '2026-10-11' }];
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '模拟发送成功' }));
    expect(invalidateThread).toHaveBeenCalledWith('thread-1');
    expect(refreshThreadList).toHaveBeenCalled();
  });
  it('does not invalidate history search after a failed message send', async () => {
    threadItems = [{ id: 'thread-1', title: '当前', resourceId: 'agent', updatedAt: '2026-10-11' }];
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '模拟发送失败' }));
    expect(invalidateThread).not.toHaveBeenCalled();
  });
  it('invalidates history search when the assistant reply settles', async () => {
    threadItems = [{ id: 'thread-1', title: '当前', resourceId: 'agent', updatedAt: '2026-10-11' }];
    renderPage();
    await screen.findByTestId('models');
    invalidateThread.mockClear();
    refreshThreadList.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '模拟回复结束' }));
    expect(invalidateThread).toHaveBeenCalledWith('thread-1');
    expect(refreshThreadList).toHaveBeenCalled();
  });
  it('opens from Ctrl/Cmd+K and navigates with encoded thread and message ids', async () => {
    threadItems = [{ id: 'thread-1', title: '当前', resourceId: 'agent', updatedAt: '2026-10-11' }];
    const router = createMemoryRouter([{
      element: <AgentShell user={testUser} onLogout={vi.fn()} />,
      children: [{ path: '/agent/:threadId', element: <AgentPage /> }],
    }], { initialEntries: ['/agent/thread-1'] });
    render(<RouterProvider router={router} />);
    await screen.findByTestId('models');
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    const input = await screen.findByLabelText('搜索历史对话中的问题和回答');
    fireEvent.change(input, { target: { value: 'find' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/agent/${encodeURIComponent('thread/special')}`);
      expect(router.state.location.search).toBe(`?targetMessageId=${encodeURIComponent('msg?id=1')}`);
    });
  });
});
