import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPage } from './AgentPage';

const flash = 'public:11111111-1111-4111-8111-111111111111';
const pro = 'public:22222222-2222-4222-8222-222222222222';
const priv = 'private:33333333-3333-4333-8333-333333333333';
const update = vi.fn();
const get = vi.fn();
const listMessages = vi.fn();
const getSelectableModels = vi.fn();
const model = (ref: string, modelId: string, extra = {}) => ({ ref, scope: 'public', displayName: modelId,
  providerId: 'deepseek', modelId, baseUrl: 'https://api.example.com', apiMode: 'chat', enabled: true,
  hasApiKey: true, keyHint: '1234', ...extra });
const listAgentsModelProviders = vi.fn();
vi.mock('./client', () => ({ AGENT_ID: 'agent', client: {
  getAgent: () => ({ details: () => Promise.resolve({ name: '智能体', modelId: 'openai/gpt-5.6-terra', tools: {} }) }),
  getMemoryConfig: () => Promise.resolve({ config: { observationalMemory: { observationModel: 'deepseek/deepseek-v4-flash' } } }),
  listAgentsModelProviders: () => listAgentsModelProviders(),
  getMemoryThread: () => ({ get, listMessages, update }),
} }));
const listPrivateModels = vi.fn();
const createPrivateModel = vi.fn();
const updatePrivateModel = vi.fn();
const deletePrivateModel = vi.fn();
vi.mock('./model-catalog-client', () => ({
  getSelectableModels: () => getSelectableModels(),
  listPrivateModels: () => listPrivateModels(),
  createPrivateModel: (input: unknown) => createPrivateModel(input),
  updatePrivateModel: (ref: string, patch: unknown) => updatePrivateModel(ref, patch),
  deletePrivateModel: (ref: string) => deletePrivateModel(ref),
}));
vi.mock('./use-thread-list', () => ({ useThreadList: () => ({
  threads: [], loading: false, error: null, refresh: vi.fn(), createThread: vi.fn(),
}) }));
vi.mock('./AgentChat', () => ({ AgentChat: ({ models, sendBlockedReason }: {
  models: { chatModel: string; memoryModel: string } | null; sendBlockedReason?: string | null;
}) => <div data-testid="models">{models ? `${models.chatModel}|${models.memoryModel}` : 'none'}
  <span data-testid="blocked">{sendBlockedReason ?? ''}</span></div> }));

function threadWith(models: unknown) {
  get.mockResolvedValue({ id: 'thread-1', resourceId: 'agent', metadata: { other: 'preserve', neroAgentModels: models } });
}

beforeEach(() => {
  localStorage.clear();
  getSelectableModels.mockResolvedValue([model(flash, 'deepseek-v4-flash', { isDefault: true }),
    model(pro, 'deepseek-v4-pro')]);
  threadWith({ chatModel: flash, memoryModel: flash });
  listMessages.mockResolvedValue({ messages: [], hasMore: false });
  update.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.clearAllMocks(); document.documentElement.classList.remove('light'); });

function renderPage() {
  return render(<MemoryRouter initialEntries={['/agent/thread-1']}><Routes>
    <Route path="/agent/:threadId" element={<AgentPage user={{ id: 'agent', email: 'test@example.com',
      displayName: 'Test', roles: ['user'] }} onLogout={vi.fn()} />} />
  </Routes></MemoryRouter>);
}

describe('Agent page settings', () => {
  it('loads catalog refs and persists a new conversation model without the legacy provider list', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('models').textContent).toContain(`${flash}|${flash}`));
    expect(listAgentsModelProviders).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.change(screen.getByRole('combobox', { name: '会话模型' }), { target: { value: pro } });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ metadata: {
      other: 'preserve', neroAgentModels: { chatModel: pro, memoryModel: flash },
    } }));
    expect(screen.getByTestId('models').textContent).toContain(`${pro}|${flash}`);
  });
  it('takes choices from GET /model-catalog even when VITE_AGENT_MODEL is set', async () => {
    vi.stubEnv('VITE_AGENT_MODEL', 'openai/env-only-model');
    try {
      threadWith(undefined);
      renderPage();
      await waitFor(() => expect(screen.getByTestId('models').textContent).toContain(`${flash}|${flash}`));
      expect(getSelectableModels).toHaveBeenCalled();
      expect(screen.getByTestId('models').textContent).not.toContain('env-only-model');
      fireEvent.click(screen.getByRole('button', { name: '设置' }));
      const options = within(screen.getByRole('combobox', { name: '会话模型' })).getAllByRole('option');
      expect(options.map(option => option.getAttribute('value'))).toEqual([flash, pro]);
    } finally { vi.unstubAllEnvs(); }
  });
  it('rejects an arbitrary provider/model string as a new selection', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('models').textContent).toContain(`${flash}|${flash}`));
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const select = screen.getByRole('combobox', { name: '会话模型' });
    const forged = document.createElement('option');
    forged.value = 'openai/gpt-5.6-terra'; forged.textContent = 'forged';
    select.appendChild(forged);
    fireEvent.change(select, { target: { value: 'openai/gpt-5.6-terra' } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('模型'));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByTestId('models').textContent).toContain(`${flash}|${flash}`);
  });
  it('maps a unique legacy string to its public ref and allows sending', async () => {
    threadWith({ chatModel: 'deepseek/deepseek-v4-flash', memoryModel: 'deepseek/deepseek-v4-flash' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('models').textContent).toContain(`${flash}|${flash}`));
    expect(screen.getByTestId('blocked').textContent).toBe('');
  });
  it('blocks sending for an unmatched legacy model until the user reselects', async () => {
    threadWith({ chatModel: 'openai/gone', memoryModel: flash });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('blocked').textContent).toContain('不可用'));
    expect(screen.getByTestId('models').textContent).toContain('none');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.change(screen.getByRole('combobox', { name: '会话模型' }), { target: { value: pro } });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ metadata: {
      other: 'preserve', neroAgentModels: { chatModel: pro, memoryModel: flash },
    } }));
    await waitFor(() => expect(screen.getByTestId('blocked').textContent).toBe(''));
  });
  it('blocks sending when the saved ref has left the catalog', async () => {
    threadWith({ chatModel: 'private:99999999-9999-4999-8999-999999999999', memoryModel: flash });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('blocked').textContent).toContain('不可用'));
  });
  it('adds a private model that appears only under 我的模型, then refreshes without resetting the thread', async () => {
    const mine = model(priv, 'my-model', { scope: 'private', displayName: 'Mine' });
    listPrivateModels.mockResolvedValue([]);
    createPrivateModel.mockResolvedValue(mine);
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '浅色' }));
    fireEvent.click(screen.getByRole('button', { name: 'API Key 管理' }));
    await screen.findByText('还没有自己的模型');
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
    type('显示名称', 'Mine'); type('Provider ID', 'deepseek'); type('Model ID', 'my-model');
    type('Base URL', 'https://api.example.com/v1'); type('API Key', 'sk-secret-9999');
    getSelectableModels.mockResolvedValue([model(flash, 'deepseek-v4-flash', { isDefault: true }),
      model(pro, 'deepseek-v4-pro'), mine]);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(getSelectableModels).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '返回设置' }));
    const select = screen.getByRole('combobox', { name: '会话模型' });
    const mineGroup = within(select).getByRole('group', { name: '我的模型' });
    expect(within(mineGroup).getByText(/Mine/)).toBeTruthy();
    expect(within(within(select).getByRole('group', { name: '公共模型' })).queryByText(/Mine/)).toBeNull();
    expect(screen.getByTestId('models').textContent).toContain(`${flash}|${flash}`);
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(JSON.stringify({ ...localStorage })).not.toContain('sk-secret');
  });
  it('blocks sending with a reselect prompt after the selected private model is disabled', async () => {
    const mine = model(priv, 'my-model', { scope: 'private', displayName: 'Mine' });
    getSelectableModels.mockResolvedValue([model(flash, 'deepseek-v4-flash', { isDefault: true }), mine]);
    threadWith({ chatModel: priv, memoryModel: flash });
    listPrivateModels.mockResolvedValue([mine]);
    updatePrivateModel.mockResolvedValue({ ...mine, enabled: false });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('models').textContent).toContain(`${priv}|${flash}`));
    expect(screen.getByTestId('blocked').textContent).toBe('');
    getSelectableModels.mockResolvedValue([model(flash, 'deepseek-v4-flash', { isDefault: true })]);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: 'API Key 管理' }));
    fireEvent.click(await screen.findByRole('button', { name: '停用 Mine' }));
    await waitFor(() => expect(screen.getByTestId('blocked').textContent).toContain('重新选择模型'));
    expect(screen.getByTestId('models').textContent).toContain('none');
    expect(listMessages).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '返回设置' }));
    expect(screen.getByRole('status').textContent).toContain('重新选择模型');
    expect(screen.getByRole('button', { name: '深色' })).toBeTruthy();
  });
  it('deletes a private model only after confirmation', async () => {
    const mine = model(priv, 'my-model', { scope: 'private', displayName: 'Mine' });
    getSelectableModels.mockResolvedValue([model(flash, 'deepseek-v4-flash', { isDefault: true }), mine]);
    threadWith({ chatModel: priv, memoryModel: flash });
    listPrivateModels.mockResolvedValue([mine]);
    deletePrivateModel.mockResolvedValue(undefined);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('models').textContent).toContain(`${priv}|${flash}`));
    getSelectableModels.mockResolvedValue([model(flash, 'deepseek-v4-flash', { isDefault: true })]);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: 'API Key 管理' }));
    fireEvent.click(await screen.findByRole('button', { name: '删除 Mine' }));
    expect(deletePrivateModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deletePrivateModel).toHaveBeenCalledWith(priv));
    await waitFor(() => expect(screen.getByTestId('blocked').textContent).toContain('重新选择模型'));
  });
  it('applies and remembers the light theme', async () => {
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '浅色' }));
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(localStorage.getItem('nero-agent-theme')).toBe('light');
  });
});
