import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentComposer } from './AgentComposer';

afterEach(cleanup);

describe('Composer run controls', () => {
  it('prevents duplicate sends while a run is active and exposes stop', () => {
    const send = vi.fn(); const stop = vi.fn();
    render(<AgentComposer draft="测试" onDraftChange={vi.fn()} isRunning={true} onSend={send} onStop={stop} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '发送消息' }), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
