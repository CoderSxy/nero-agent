import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentComposer } from './AgentComposer';
import type { SafeModel } from './model-catalog-client';

afterEach(cleanup);

describe('Composer run controls', () => {
  it('shows the selected default model at bottom left and icon send control at bottom right', () => {
    const first = 'public:11111111-1111-4111-8111-111111111111';
    const second = 'private:22222222-2222-4222-8222-222222222222';
    const catalog = [first, second].map((ref, index) => ({
      ref, scope: index === 0 ? 'public' : 'private', displayName: index === 0 ? '默认模型' : '个人模型',
      providerId: 'test', modelId: `m${index}`, enabled: true, baseUrl: 'https://example.test',
      apiMode: 'chat', hasApiKey: true, keyHint: '1234',
    })) as SafeModel[];
    const change = vi.fn();
    const { container } = render(<AgentComposer draft="测试" onDraftChange={vi.fn()} isRunning={false}
      onSend={vi.fn()} onStop={vi.fn()} catalog={catalog} modelRef={first} onModelChange={change} />);
    const actions = container.querySelector('[data-slot="composer-actions"]')!;
    const select = screen.getByRole('combobox', { name: '模型' });
    const send = screen.getByRole('button', { name: '发送' });
    expect(actions.firstElementChild).toBe(select);
    expect(actions.lastElementChild).toBe(send);
    expect(select.textContent).toContain('默认模型');
    expect(send.querySelector('svg')).toBeTruthy();
    expect(send.textContent).toBe('');
    fireEvent.click(select);
    expect(screen.getByRole('listbox', { name: '选择模型' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: '个人' } });
    expect(screen.queryByRole('option', { name: /默认模型/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /个人模型/ }));
    expect(change).toHaveBeenCalledWith(second);
  });
  it('prevents duplicate sends while a run is active and exposes stop', () => {
    const send = vi.fn(); const stop = vi.fn();
    render(<AgentComposer draft="测试" onDraftChange={vi.fn()} isRunning={true} onSend={send} onStop={stop} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '发送消息' }), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
