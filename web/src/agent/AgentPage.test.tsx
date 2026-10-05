import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPage } from './AgentPage';

const flash = 'public:11111111-1111-4111-8111-111111111111';
const pro = 'public:22222222-2222-4222-8222-222222222222';
const mine = 'private:33333333-3333-4333-8333-333333333333';
const update = vi.fn();
const get = vi.fn();
const listMessages = vi.fn();
const getSelectableModels = vi.fn();
const createThread = vi.fn();
const deleteThread = vi.fn();
let threadItems: Array<{ id: string; title: string; resourceId: string; updatedAt: string }> = [];
const listAgentsModelProviders = vi.fn();
const model = (ref: string, modelId: string, extra = {}) => ({ ref, scope: 'public', displayName: modelId,
  providerId: 'deepseek', modelId, baseUrl: 'https://api.example.com', apiMode: 'chat', enabled: true,
  hasApiKey: true, keyHint: '1234', ...extra });

vi.mock('./client', () => ({ AGENT_ID: 'agent', client: {
  getAgent: () => ({ details: () => Promise.resolve({ name: '智能体', modelId: 'openai/gpt-5.6-terra', tools: {} }) }),
  getMemoryConfig: () => Promise.resolve({ config: { observationalMemory: { observationModel: 'deepseek/deepseek-v4-flash' } } }),
  listAgentsModelProviders: () => listAgentsModelProviders(),
  getMemoryThread: () => ({ get, listMessages, update }),
} }));
vi.mock('./model-catalog-client', () => ({ getSelectableModels: () => getSelectableModels() }));
vi.mock('./use-thread-list', () => ({ useThreadList: () => ({
  threads: threadItems, loading: false, error: null, refresh: vi.fn(), createThread, deleteThread,
}) }));
vi.mock('./AgentChat', () => ({ AgentChat: ({ models, sendBlockedReason, catalog, modelRef, onModelChange, modelError }: {
  models: { chatModel: string; memoryModel: string } | null; sendBlockedReason?: string | null;
  catalog?: Array<{ ref: string; displayName: string }>; modelRef?: string; onModelChange?: (ref: string) => void;
  modelError?: string | null;
}) => <div data-testid="models">{models ? `${models.chatModel}|${models.memoryModel}` : 'none'}
  <span data-testid="blocked">{sendBlockedReason ?? ''}</span>
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
});
afterEach(() => { cleanup(); vi.clearAllMocks(); document.documentElement.classList.remove('light'); });

function renderPage(path = '/agent/thread-1') {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/agent/new" element={<AgentPage user={{ id: 'agent', email: 'test@example.com',
      displayName: 'Test', roles: ['user'] }} onLogout={vi.fn()} />} />
    <Route path="/agent/:threadId" element={<AgentPage user={{ id: 'agent', email: 'test@example.com',
      displayName: 'Test', roles: ['user'] }} onLogout={vi.fn()} />} />
  </Routes></MemoryRouter>);
}

describe('Agent page model selection', () => {
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
    expect(await screen.findByText('开始一段新对话')).toBeTruthy();
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
      fireEvent.click(screen.getByRole('button', { name: '设置' }));
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

  it('keeps theme switching in Settings', async () => {
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '浅色' }));
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });
});
