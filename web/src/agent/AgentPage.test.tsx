import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPage } from './AgentPage';

const flash = 'public:11111111-1111-4111-8111-111111111111';
const pro = 'public:22222222-2222-4222-8222-222222222222';
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
vi.mock('./model-catalog-client', () => ({ getSelectableModels: () => getSelectableModels() }));
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
  it('applies and remembers the light theme', async () => {
    renderPage();
    await screen.findByTestId('models');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '浅色' }));
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(localStorage.getItem('nero-agent-theme')).toBe('light');
  });
});
