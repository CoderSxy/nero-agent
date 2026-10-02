import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

describe('agent login', () => {
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
    expect(await screen.findByText('开始一段新对话')).toBeTruthy();
    expect(sessionStorage.getItem('nero-agent-session')).toBe('test-token');
  });
});
