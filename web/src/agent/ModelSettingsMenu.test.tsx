import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSettingsMenu } from './ModelSettingsMenu';

afterEach(cleanup);

const props = {
  models: { chatModel: 'deepseek/deepseek-v4-flash', memoryModel: 'deepseek/deepseek-v4-flash' },
  providers: [{ id: 'deepseek', name: 'DeepSeek', connected: true, envVar: 'DEEPSEEK_API_KEY',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'] }],
  theme: 'dark' as const,
  onModelsChange: vi.fn(), onThemeChange: vi.fn(),
};

describe('sidebar settings menu', () => {
  it('opens an upward model menu and changes the current conversation model', () => {
    render(<ModelSettingsMenu {...props} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: '会话模型' }),
      { target: { value: 'deepseek/deepseek-v4-pro' } });
    expect(props.onModelsChange).toHaveBeenCalledWith({
      chatModel: 'deepseek/deepseek-v4-pro', memoryModel: 'deepseek/deepseek-v4-flash',
    });
  });
  it('changes memory model and light theme independently', () => {
    render(<ModelSettingsMenu {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.change(screen.getByRole('combobox', { name: '记忆模型' }),
      { target: { value: 'deepseek/deepseek-v4-pro' } });
    expect(props.onModelsChange).toHaveBeenCalledWith({
      chatModel: 'deepseek/deepseek-v4-flash', memoryModel: 'deepseek/deepseek-v4-pro',
    });
    fireEvent.click(screen.getByRole('button', { name: '浅色' }));
    expect(props.onThemeChange).toHaveBeenCalledWith('light');
  });
});
