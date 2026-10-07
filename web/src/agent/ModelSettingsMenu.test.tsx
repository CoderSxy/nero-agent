import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSettingsMenu } from './ModelSettingsMenu';

afterEach(cleanup);

describe('sidebar settings menu', () => {
  it('only shows appearance controls, with no personal model configuration', () => {
    render(<ModelSettingsMenu theme="dark" onThemeChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.getByRole('button', { name: '浅色' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'API Key 管理' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('changes the theme', () => {
    const change = vi.fn();
    render(<ModelSettingsMenu theme="dark" onThemeChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '浅色' }));
    expect(change).toHaveBeenCalledWith('light');
  });

  it('requires confirmation before logging out from settings', () => {
    const logout = vi.fn();
    render(<ModelSettingsMenu theme="dark" onThemeChange={vi.fn()}
      user={{ displayName: '小明', email: 'ming@example.com' }} onLogout={logout} />);
    expect(screen.getByText('小明')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: '确认退出登录' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(logout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    fireEvent.click(screen.getByRole('button', { name: '确认退出' }));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
