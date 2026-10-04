import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSettingsMenu } from './ModelSettingsMenu';
import type { SafeModel } from './model-catalog-client';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const flash = 'public:11111111-1111-4111-8111-111111111111';
const pro = 'private:22222222-2222-4222-8222-222222222222';
const catalog: SafeModel[] = [
  { ref: flash, scope: 'public', displayName: 'Flash', providerId: 'deepseek', modelId: 'v4-flash',
    baseUrl: 'https://api.example.com', apiMode: 'chat', enabled: true, hasApiKey: true, keyHint: '1234' },
  { ref: pro, scope: 'private', displayName: 'Pro', providerId: 'deepseek', modelId: 'v4-pro',
    baseUrl: 'https://api.example.com', apiMode: 'chat', enabled: true, hasApiKey: true, keyHint: '5678' },
];
const props = {
  models: { chatModel: flash, memoryModel: flash } as const,
  catalog, theme: 'dark' as const,
  onModelsChange: vi.fn(), onThemeChange: vi.fn(),
};

describe('sidebar settings menu', () => {
  it('groups public and private models and changes the conversation model by ref', () => {
    render(<ModelSettingsMenu {...props} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const select = screen.getByRole('combobox', { name: '会话模型' });
    expect(within(select).getByRole('group', { name: '公共模型' })).toBeTruthy();
    expect(within(select).getByRole('group', { name: '我的模型' })).toBeTruthy();
    fireEvent.change(select, { target: { value: pro } });
    expect(props.onModelsChange).toHaveBeenCalledWith({ chatModel: pro, memoryModel: flash });
  });
  it('changes memory model and light theme independently', () => {
    render(<ModelSettingsMenu {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.change(screen.getByRole('combobox', { name: '记忆模型' }), { target: { value: pro } });
    expect(props.onModelsChange).toHaveBeenCalledWith({ chatModel: flash, memoryModel: pro });
    fireEvent.click(screen.getByRole('button', { name: '浅色' }));
    expect(props.onThemeChange).toHaveBeenCalledWith('light');
  });
  it('shows an unavailable placeholder and waits for both models before saving', () => {
    render(<ModelSettingsMenu {...props} models={{ memoryModel: flash }} />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect((screen.getByRole('combobox', { name: '会话模型' }) as HTMLSelectElement).value).toBe('');
    expect(screen.getByText('模型不可用，请重新选择')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: '会话模型' }), { target: { value: pro } });
    expect(props.onModelsChange).toHaveBeenCalledWith({ chatModel: pro, memoryModel: flash });
  });
});
