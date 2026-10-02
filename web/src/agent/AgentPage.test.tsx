import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPage } from './AgentPage';

const update = vi.fn();
const get = vi.fn();
const listMessages = vi.fn();
vi.mock('./client', () => ({ AGENT_ID: 'agent', client: {
  getAgent: () => ({ details: () => Promise.resolve({ name: '智能体', modelId: 'openai/gpt-5.6-terra', tools: {} }) }),
  getMemoryConfig: () => Promise.resolve({ config: { observationalMemory: { observationModel: 'deepseek/deepseek-v4-flash' } } }),
  listAgentsModelProviders: () => Promise.resolve({ providers: [{ id: 'deepseek', name: 'DeepSeek', connected: true,
    envVar: 'DEEPSEEK_API_KEY', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] }] }),
  getMemoryThread: () => ({ get, listMessages, update }),
} }));
vi.mock('./use-thread-list', () => ({ useThreadList: () => ({
  threads: [], loading: false, error: null, refresh: vi.fn(), createThread: vi.fn(),
}) }));
vi.mock('./AgentChat', () => ({ AgentChat: ({ models }: { models: { chatModel: string; memoryModel: string } }) =>
  <div data-testid="models">{models.chatModel}|{models.memoryModel}</div> }));

beforeEach(() => {
  localStorage.clear();
  get.mockResolvedValue({ id: 'thread-1', resourceId: 'agent', metadata: {
    other: 'preserve', neroAgentModels: {
      chatModel: 'deepseek/deepseek-v4-flash', memoryModel: 'deepseek/deepseek-v4-flash',
    },
  } });
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
  it('loads thread models and persists a new conversation model', async () => {
    renderPage();
    expect(await screen.findByTestId('models')).toHaveProperty('textContent',
      'deepseek/deepseek-v4-flash|deepseek/deepseek-v4-flash');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.change(screen.getByRole('combobox', { name: '会话模型' }),
      { target: { value: 'deepseek/deepseek-v4-pro' } });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ metadata: {
      other: 'preserve', neroAgentModels: {
        chatModel: 'deepseek/deepseek-v4-pro', memoryModel: 'deepseek/deepseek-v4-flash',
      },
    } }));
    expect(screen.getByTestId('models').textContent).toContain('deepseek/deepseek-v4-pro');
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
