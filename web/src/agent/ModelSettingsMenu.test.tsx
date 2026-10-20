import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManageMenu } from './ManageMenu';

afterEach(cleanup);

function renderMenu(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('sidebar manage menu', () => {
  it('expands and collapses management entries', () => {
    renderMenu(<ManageMenu theme="dark" onThemeChange={vi.fn()} isAdmin />);
    expect(screen.queryByRole('menu', { name: '管理' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    expect(screen.getByRole('menu', { name: '管理' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '技能管理' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '定时任务' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '外观' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    expect(screen.queryByRole('menu', { name: '管理' })).toBeNull();
  });

  it('hides scheduled tasks for non-admins and keeps skills plus appearance controls', () => {
    renderMenu(<ManageMenu theme="dark" onThemeChange={vi.fn()} isAdmin={false} />);
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    expect(screen.getByRole('menuitem', { name: '技能管理' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '定时任务' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '外观' }));
    fireEvent.click(screen.getByRole('button', { name: '浅色' }));
  });

  it('changes the theme from appearance', () => {
    const change = vi.fn();
    renderMenu(<ManageMenu theme="dark" onThemeChange={change} isAdmin />);
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '外观' }));
    fireEvent.click(screen.getByRole('button', { name: '浅色' }));
    expect(change).toHaveBeenCalledWith('light');
  });

  it('requires confirmation before logging out', () => {
    const logout = vi.fn();
    renderMenu(<ManageMenu theme="dark" onThemeChange={vi.fn()} isAdmin
      user={{ displayName: '小明', email: 'ming@example.com' }} onLogout={logout} />);
    expect(screen.getByText('小明')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }));
    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: '确认退出登录' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(logout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }));
    fireEvent.click(screen.getByRole('button', { name: '确认退出' }));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
