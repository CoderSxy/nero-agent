import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigPanel } from './ConfigPanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('read only agent configuration', () => {
  it('presents Studio-like tool chips, counts, and configuration groups', () => {
    render(<ConfigPanel agent={{ name: '智能体', tools: { task_write: {}, web_search: {} }, workflows: {},
      instructions: '你是一个智能体。' } as never} memory={{ config: { lastMessages: 10,
      generateTitle: true, observationalMemory: { enabled: true } } } as never}
      loading={false} error={null} />);
    expect(screen.getByText('工具')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('task_write')).toBeTruthy();
    expect(screen.getByText('web_search')).toBeTruthy();
    expect(screen.getByText('工作流')).toBeTruthy();
    expect(screen.getByText('处理器')).toBeTruthy();
    expect(screen.getByText('技能')).toBeTruthy();
    expect(screen.getByText('评分器')).toBeTruthy();
    expect(screen.getByText('系统提示词')).toBeTruthy();
    expect(screen.getAllByText('Enabled').length).toBeGreaterThan(0);
    expect(screen.getByText('你是一个智能体。')).toBeTruthy();
  });
  it('lets readers reveal tool names beyond the first ten', () => {
    const tools = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`tool_${index + 1}`, {}]));
    render(<ConfigPanel agent={{ name: '智能体', tools } as never} loading={false} error={null} />);
    expect(screen.queryByText('tool_12')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '显示剩余 2 项' }));
    expect(screen.getByText('tool_12')).toBeTruthy();
  });
  it('renders prompt markdown in Read and raw text in Source', () => {
    render(<ConfigPanel agent={{ name: '智能体', tools: {}, instructions: '**加粗**' } as never}
      loading={false} error={null} />);
    expect(screen.getByText('加粗').tagName).toBe('STRONG');
    fireEvent.click(screen.getByRole('button', { name: '源码' }));
    expect(screen.getByText('**加粗**')).toBeTruthy();
  });
  it('does not count the same processor twice across input and output', () => {
    render(<ConfigPanel agent={{ name: '智能体', tools: {},
      inputProcessors: [{ name: 'persist' }], outputProcessors: [{ name: 'persist' }] } as never}
      loading={false} error={null} />);
    expect(screen.getAllByText('persist')).toHaveLength(1);
  });
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
    expect(screen.getByText('deepseek/deepseek-v4-pro')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起记忆' }));
    expect(screen.getByRole('button', { name: '展开记忆' })).toBeTruthy();
  });
  it('keeps workspace metadata in Config without embedding the file browser', () => {
    render(<ConfigPanel agent={{ name: '智能体', workspaceId: 'agent-workspace', tools: {} } as never}
      memory={null} loading={false} error={null} />);
    fireEvent.click(screen.getByRole('button', { name: '展开工作区' }));
    expect(screen.getByText('智能体配置：agent-workspace')).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });
  it('keeps the available catalog separate from skills loaded this turn', () => {
    render(<ConfigPanel agent={{ name: '智能体', tools: {}, skills: { 'framework-skill': {} } } as never}
      availableCatalog={['checklist']}
      turnActivations={[{
        serverExecutionId: 'exec-1', skillId: 'skill-1', name: 'checklist', version: 3,
        hashPrefix: '01234567', status: 'failed', errorCode: 'SKILL_NOT_FOUND',
      }]}
      loading={false} error={null} />);
    const catalog = screen.getByRole('region', { name: '可用目录' });
    const loaded = screen.getByRole('region', { name: '本轮加载' });
    expect(catalog.textContent).toContain('checklist');
    expect(catalog.textContent).not.toContain('加载失败');
    expect(loaded.textContent).toContain('加载失败');
    expect(loaded.textContent).toContain('checklist');
    expect(loaded.textContent).toContain('v3');
    expect(loaded.textContent).toContain('01234567');
    expect(loaded.textContent).not.toContain('framework-skill');
    expect(screen.queryByText('已加载')).toBeNull();
  });
});
