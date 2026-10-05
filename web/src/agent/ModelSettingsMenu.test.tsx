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
});
