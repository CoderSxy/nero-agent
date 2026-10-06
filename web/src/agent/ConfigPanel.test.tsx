import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigPanel } from './ConfigPanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('read only agent configuration', () => {
  it('renders returned values and handles missing optional data', () => {
    render(<ConfigPanel agent={{ name: '智能体', modelId: 'deepseek-v4', tools: {} } as never}
      memory={null} loading={false} error={null} />);
    expect(screen.getByText('deepseek-v4')).toBeTruthy();
    expect(screen.getAllByText('未提供').length).toBeGreaterThan(0);
    expect(screen.getByText('工作区')).toBeTruthy();
  });
  it('collapses and expands a section', () => {
    render(<ConfigPanel agent={{ name: '智能体', modelId: 'deepseek-v4', tools: {} } as never}
      memory={null} loading={false} error={null} />);
    fireEvent.click(screen.getByRole('button', { name: '收起概览' }));
    expect(screen.queryByText('deepseek-v4')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开概览' }));
    expect(screen.getByText('deepseek-v4')).toBeTruthy();
  });
  it('shows the session model and memory model selected in settings', () => {
    render(<ConfigPanel agent={{ name: '智能体', modelId: 'openai/gpt-5.6-terra', tools: {} } as never}
      memory={{ config: { observationalMemory: { enabled: true } } } as never}
      models={{ chatModel: 'deepseek/deepseek-v4-flash', memoryModel: 'deepseek/deepseek-v4-pro' }}
      loading={false} error={null} />);
    expect(screen.getByText('deepseek/deepseek-v4-flash')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开记忆' }));
    expect(screen.getByText('deepseek/deepseek-v4-pro')).toBeTruthy();
  });
  it('keeps workspace metadata in Config without embedding the file browser', () => {
    render(<ConfigPanel agent={{ name: '智能体', workspaceId: 'agent-workspace', tools: {} } as never}
      memory={null} loading={false} error={null} />);
    fireEvent.click(screen.getByRole('button', { name: '展开工作区' }));
    expect(screen.getByText('Agent 配置：agent-workspace')).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });
});
