import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFileTree } from './WorkspaceFileTree';

const listWorkspaceFiles = vi.fn();
vi.mock('./client', () => ({ listWorkspaceFiles: (...args: unknown[]) => listWorkspaceFiles(...args) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const files = [
  { path: 'docs', type: 'directory', size: 0 },
  { path: 'docs/nested', type: 'directory', size: 0 },
  { path: 'docs/nested/readme.md', type: 'file', size: 8 },
  { path: 'root.txt', type: 'file', size: 4 },
];

describe('workspace file tree', () => {
  it('expands nested folders and opens a file without downloading it', async () => {
    listWorkspaceFiles.mockResolvedValue(files);
    const onOpenFile = vi.fn();
    render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={onOpenFile} />);
    expect(await screen.findByRole('button', { name: '展开 docs' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开 docs/nested/readme.md' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开 docs' }));
    fireEvent.click(screen.getByRole('button', { name: '展开 docs/nested' }));
    fireEvent.click(screen.getByRole('button', { name: '打开 docs/nested/readme.md' }));
    expect(onOpenFile).toHaveBeenCalledWith('docs/nested/readme.md');
    expect(screen.getByRole('button', { name: '收起 docs/nested' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps expanded folders during refresh and uses the Agent source', async () => {
    listWorkspaceFiles.mockResolvedValue(files);
    const view = render(<WorkspaceFileTree source="agent" workspaceId="agent-workspace" refreshVersion={0}
      onOpenFile={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '展开 docs' }));
    view.rerender(<WorkspaceFileTree source="agent" workspaceId="agent-workspace" refreshVersion={1}
      onOpenFile={vi.fn()} />);
    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: '收起 docs' })).toBeTruthy();
    expect(listWorkspaceFiles).toHaveBeenCalledWith('agent', 'agent-workspace');
  });

  it('shows empty and error states', async () => {
    listWorkspaceFiles.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('无法加载'));
    const view = render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()} />);
    expect(await screen.findByText('暂无文件')).toBeTruthy();
    view.rerender(<WorkspaceFileTree source="personal" refreshVersion={1} onOpenFile={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '无法加载');
  });
});
