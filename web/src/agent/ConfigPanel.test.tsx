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
  it('shows files created in the current conversation under the workspace section', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspaceId: 'ws-user', files: [
      { path: 'threads', type: 'directory', size: 0 },
      { path: 'threads/thread-1', type: 'directory', size: 0 },
      { path: 'threads/thread-1/output', type: 'directory', size: 0 },
      { path: 'threads/thread-1/output/report.md', type: 'file', size: 12 },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render(<ConfigPanel agent={{ name: '智能体', tools: {} } as never}
      threadId="thread-1" memory={null} loading={false} error={null} />);
    fireEvent.click(screen.getByRole('button', { name: '展开工作区' }));
    expect(await screen.findByRole('button', { name: '下载 threads/thread-1/output/report.md' })).toBeTruthy();
    expect(screen.getByText('threads/')).toBeTruthy();
    expect(screen.getByText('output/')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/current-workspace/files', expect.anything());
  });

  it('refreshes the workspace file list without reloading the page', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaceId: 'ws-user', files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaceId: 'ws-user', files: [
        { path: 'projects/new.md', type: 'file', size: 3 },
      ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render(<ConfigPanel agent={{ name: '智能体', tools: {} } as never}
      threadId="thread-1" memory={null} loading={false} error={null} />);
    fireEvent.click(screen.getByRole('button', { name: '展开工作区' }));
    await screen.findByText('暂无文件');
    fireEvent.click(screen.getByRole('button', { name: '刷新文件' }));
    expect(await screen.findByRole('button', { name: '下载 projects/new.md' })).toBeTruthy();
  });
  it('reads all files from the active Agent workspace when the user workspace is disabled', async () => {
    const fetch = vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(
      path.includes('source=agent')
        ? JSON.stringify({ workspaceId: 'agent-workspace', files: [
          { path: 'docs/created.md', type: 'file', size: 7 }] })
        : JSON.stringify({ workspaceId: 'ws-user', files: [
          { path: 'projects/own.md', type: 'file', size: 8 }] }), { status: 200 })));
    vi.stubGlobal('fetch', fetch);
    render(<ConfigPanel agent={{ name: '智能体', workspaceId: 'agent-workspace', tools: {} } as never}
      threadId="thread-1" memory={null} loading={false} error={null} />);
    fireEvent.click(screen.getByRole('button', { name: '展开工作区' }));
    expect(await screen.findByRole('button', { name: '下载 docs/created.md' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '下载 projects/own.md' })).toBeNull();
    expect(fetch).toHaveBeenCalledWith('/current-workspace/files?source=agent', expect.anything());
    expect(fetch).not.toHaveBeenCalledWith('/current-workspace/files', expect.anything());
  });
});
