import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFileTree } from './WorkspaceFileTree';

const listWorkspaceFiles = vi.fn();
const deleteWorkspaceFiles = vi.fn();
vi.mock('./client', () => ({
  listWorkspaceFiles: (...args: unknown[]) => listWorkspaceFiles(...args),
  deleteWorkspaceFiles: (...args: unknown[]) => deleteWorkspaceFiles(...args),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const personalFiles = [
  { path: 'shared', type: 'directory', size: 0 },
  { path: 'uploads', type: 'directory', size: 100 },
  { path: 'uploads/abc', type: 'directory', size: 100 },
  { path: 'uploads/abc/a.txt', type: 'file', size: 40 },
  { path: 'uploads/abc/b.txt', type: 'file', size: 60 },
  { path: 'docs', type: 'directory', size: 12 },
  { path: 'docs/nested', type: 'directory', size: 8 },
  { path: 'docs/nested/readme.md', type: 'file', size: 8 },
  { path: 'docs/note.txt', type: 'file', size: 4 },
  { path: 'root.txt', type: 'file', size: 4 },
  { path: 'threads', type: 'directory', size: 0 },
  { path: 'threads/t1', type: 'directory', size: 0 },
  { path: 'threads/t1/input', type: 'directory', size: 0 },
  { path: 'threads/t1/output', type: 'directory', size: 0 },
];

const usage = { usedBytes: 116, quotaBytes: 500 * 1024 * 1024, fileCount: 4 };

describe('workspace file tree', () => {
  it('expands nested folders and opens a file without downloading it', async () => {
    listWorkspaceFiles.mockResolvedValue({ files: personalFiles, usage });
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
    listWorkspaceFiles.mockResolvedValue({ files: personalFiles });
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
    listWorkspaceFiles.mockResolvedValueOnce({ files: [] }).mockRejectedValueOnce(new Error('无法加载'));
    const view = render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()} />);
    expect(await screen.findByText('暂无文件')).toBeTruthy();
    view.rerender(<WorkspaceFileTree source="personal" refreshVersion={1} onOpenFile={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '无法加载');
  });

  it('shows personal workspace usage as used / 500 MiB with remaining space', async () => {
    listWorkspaceFiles.mockResolvedValue({ files: personalFiles, usage });
    render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()} />);
    expect(await screen.findByText(/已用 116 B \/ 500 MiB/)).toBeTruthy();
    expect(screen.getByText(/剩余/)).toBeTruthy();
  });

  it('deletes a single file from the row menu after confirmation', async () => {
    listWorkspaceFiles
      .mockResolvedValueOnce({ files: personalFiles, usage })
      .mockResolvedValueOnce({
        files: personalFiles.filter(entry => entry.path !== 'root.txt'),
        usage: { ...usage, usedBytes: 112, fileCount: 3 },
      });
    deleteWorkspaceFiles.mockResolvedValue({
      results: [{ path: 'root.txt', ok: true }],
      deletedFiles: 1,
      freedBytes: 4,
      usage: { usedBytes: 112, quotaBytes: usage.quotaBytes, fileCount: 3 },
    });
    const onFilesChanged = vi.fn();
    render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()}
      onAttachFile={vi.fn()} onFilesChanged={onFilesChanged} />);
    await screen.findByText(/已用 116 B/);
    fireEvent.click(screen.getByRole('button', { name: 'root.txt 的更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    const dialog = await screen.findByRole('dialog', { name: '确认删除' });
    expect(dialog.textContent).toMatch(/删除后无法恢复/);
    expect(dialog.textContent).toMatch(/1/);
    expect(dialog.textContent).toMatch(/4 B/);
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteWorkspaceFiles).toHaveBeenCalledWith(['root.txt']));
    await waitFor(() => expect(onFilesChanged).toHaveBeenCalled());
    expect(await screen.findByText(/已用 112 B \/ 500 MiB/)).toBeTruthy();
  });

  it('enters batch mode with checkboxes, recursive sizes, and collapsed parent/child estimates', async () => {
    listWorkspaceFiles.mockResolvedValue({ files: personalFiles, usage });
    render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()}
      onAttachFile={vi.fn()} />);
    await screen.findByText(/已用 116 B/);
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }));
    fireEvent.click(screen.getByRole('button', { name: '展开 docs' }));
    fireEvent.click(screen.getByRole('button', { name: '展开 docs/nested' }));
    const docsRow = screen.getByRole('button', { name: '收起 docs' }).closest('li');
    const nestedRow = screen.getByRole('button', { name: '收起 docs/nested' }).closest('li');
    expect(docsRow?.textContent).toMatch(/12 B/);
    expect(nestedRow?.textContent).toMatch(/8 B/);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 docs' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 docs/nested/readme.md' }));
    const summary = screen.getByLabelText('已选摘要');
    expect(summary.textContent).toMatch(/1/);
    expect(summary.textContent).toMatch(/12 B/);
    expect(summary.textContent).not.toMatch(/20 B/);
  });

  it('cancels a delete confirmation without calling the API', async () => {
    listWorkspaceFiles.mockResolvedValue({ files: personalFiles, usage });
    render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()}
      onAttachFile={vi.fn()} />);
    await screen.findByText(/已用 116 B/);
    fireEvent.click(screen.getByRole('button', { name: 'root.txt 的更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '确认删除' }))
      .getByRole('button', { name: '取消' }));
    expect(deleteWorkspaceFiles).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '确认删除' })).toBeNull();
  });

  it('does not allow deleting protected workspace roots from the UI', async () => {
    listWorkspaceFiles.mockResolvedValue({ files: personalFiles, usage });
    render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()}
      onAttachFile={vi.fn()} />);
    await screen.findByText(/已用 116 B/);
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }));
    expect(screen.getByRole('checkbox', { name: '选择 shared' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: '选择 uploads' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: '选择 threads' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '展开 threads' }));
    fireEvent.click(screen.getByRole('button', { name: '展开 threads/t1' }));
    expect(screen.getByRole('checkbox', { name: '选择 threads/t1/input' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: '选择 threads/t1/output' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '取消批量删除' }));
    expect(screen.queryByRole('button', { name: 'shared 的更多操作' })).toBeNull();
  });

  it('reports partial delete failures and refreshes the tree', async () => {
    listWorkspaceFiles
      .mockResolvedValueOnce({ files: personalFiles, usage })
      .mockResolvedValueOnce({ files: personalFiles.filter(entry => entry.path !== 'docs/note.txt'
        && entry.path !== 'docs' && !entry.path.startsWith('docs/')), usage: { ...usage, usedBytes: 104 } });
    deleteWorkspaceFiles.mockResolvedValue({
      results: [
        { path: 'docs', ok: false, errorCode: 'PROTECTED_PATH' },
        { path: 'root.txt', ok: true },
      ],
      deletedFiles: 1,
      freedBytes: 4,
      usage: { usedBytes: 112, quotaBytes: usage.quotaBytes, fileCount: 3 },
    });
    const onFilesChanged = vi.fn();
    render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()}
      onAttachFile={vi.fn()} onFilesChanged={onFilesChanged} />);
    await screen.findByText(/已用 116 B/);
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 docs' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 root.txt' }));
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '确认删除' }))
      .getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteWorkspaceFiles).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/docs/));
    expect(screen.getByRole('alert').textContent).toMatch(/实际释放 4 B|释放 4 B/);
    await waitFor(() => expect(onFilesChanged).toHaveBeenCalled());
  });

  it('keeps preview clicks in normal mode and hides delete/usage for agent source', async () => {
    listWorkspaceFiles.mockResolvedValue({ files: personalFiles });
    const onOpenFile = vi.fn();
    const view = render(<WorkspaceFileTree source="agent" workspaceId="agent-workspace" refreshVersion={0}
      onOpenFile={onOpenFile} onAttachFile={vi.fn()} />);
    await screen.findByText('Agent 工作区');
    expect(screen.queryByText(/已用/)).toBeNull();
    expect(screen.queryByRole('button', { name: '批量删除' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开 root.txt' }));
    expect(onOpenFile).toHaveBeenCalledWith('root.txt');
    fireEvent.click(screen.getByRole('button', { name: 'root.txt 的更多操作' }));
    expect(screen.queryByRole('menuitem', { name: '删除' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '加入当前对话' })).toBeTruthy();
    view.unmount();
    listWorkspaceFiles.mockResolvedValue({ files: personalFiles, usage });
    render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={onOpenFile}
      onAttachFile={vi.fn()} />);
    await screen.findByText(/已用/);
    fireEvent.click(screen.getByRole('button', { name: '打开 root.txt' }));
    expect(onOpenFile).toHaveBeenCalledWith('root.txt');
  });
});
