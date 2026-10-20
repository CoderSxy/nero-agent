import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

describe('agent login', () => {
  it('renders the scheduled tasks route with the shared sidebar and a full-width task area', async () => {
    sessionStorage.setItem('nero-agent-session', 'admin-token');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      const path = String(input);
      const body = path === '/auth/me'
        ? { user: { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', roles: ['admin'] } }
        : path.startsWith('/agent-scheduled-tasks?') ? { items: [], total: 0 }
          : path === '/model-catalog' ? { models: [] } : { threads: [] };
      return { ok: true, json: async () => body };
    }));
    render(<MemoryRouter initialEntries={['/scheduled-tasks']}><App /></MemoryRouter>);

    const center = await screen.findByRole('region', { name: '定时任务列表' });
    expect(within(center).getByRole('heading', { name: '定时任务' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: '定时任务详情与配置' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '定时任务' })).toBeTruthy();
    expect(screen.getByLabelText('NERO AGENT')).toBeTruthy();
  });

  it('renders the skills management route for ordinary users', async () => {
    sessionStorage.setItem('nero-agent-session', 'user-token');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      const path = String(input);
      const body = path === '/auth/me'
        ? { user: { id: 'user-1', email: 'user@example.com', displayName: 'User', roles: ['user'] } }
        : path.startsWith('/agent-skills/groups') ? { items: [] }
          : path.startsWith('/agent-skills?') || path === '/agent-skills'
            ? { items: [], total: 0, page: 1, pageSize: 20 }
            : { threads: [] };
      return { ok: true, json: async () => body };
    }));
    render(<MemoryRouter initialEntries={['/agent/skills']}><App /></MemoryRouter>);
    const center = await screen.findByRole('region', { name: '技能管理' });
    expect(within(center).getByRole('heading', { name: '技能管理' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '技能管理' })).toBeTruthy();
  });

  it('shows a login form before an anonymous visitor can access the agent', () => {
    render(<MemoryRouter initialEntries={['/agent/new']}><App /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '登录 NERO AGENT' })).toBeTruthy();
    expect(screen.queryByText('开始一段新对话')).toBeNull();
  });

  it('logs in and keeps the session for the current browser tab', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      token: 'test-token', user: { id: 'user-1', email: 'user@example.com', displayName: 'User', roles: ['user'] },
    }) }));
    render(<MemoryRouter initialEntries={['/agent/new']}><App /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct horse battery staple' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('heading', { name: '有什么可以帮你？' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '发送消息' })).toBeTruthy();
    expect(sessionStorage.getItem('nero-agent-session')).toBe('test-token');
  });

  it('offers a Studio handoff only to an authenticated admin', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      token: 'admin-test-token', user: { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', roles: ['admin'] },
    }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/agent/new?next=studio']}><App /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    const link = await screen.findByRole('link', { name: '进入 Studio' });
    expect(link.getAttribute('href')).toBe('/studio/');
    expect(fetchMock).toHaveBeenCalledWith('/auth/studio-session', {
      method: 'POST', headers: { Authorization: 'Bearer admin-test-token' },
    });
  });

  it('does not offer the Studio handoff to an ordinary user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      token: 'user-test-token', user: { id: 'user-1', email: 'user@example.com', displayName: 'User', roles: ['user'] },
    }) }));
    render(<MemoryRouter initialEntries={['/agent/new?next=studio']}><App /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('heading', { name: '仅管理员可以进入 Studio' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '进入 Studio' })).toBeNull();
  });
});
