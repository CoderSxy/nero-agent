import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isProtectedWorkspacePath, WorkspaceFileTree } from './WorkspaceFileTree';

const listWorkspaceFiles = vi.fn();
const deleteWorkspaceFiles = vi.fn();
const fetchWorkspaceFile = vi.fn();
const uploadWorkspaceFile = vi.fn();
vi.mock('./client', () => ({
  uploadWorkspaceFile: (...args: unknown[]) => uploadWorkspaceFile(...args),
  fetchWorkspaceFile: (...args: unknown[]) => fetchWorkspaceFile(...args),
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
  it('shows uploaded files directly under uploads while preserving their real paths', async () => {
    const path = 'uploads/132a8d7c-c0bf-4f4f-93e2-6e1f17a49abc/report.html';
    listWorkspaceFiles.mockResolvedValue({ files: [
      { path: 'uploads', type: 'directory', size: 18 },
      { path: 'uploads/132a8d7c-c0bf-4f4f-93e2-6e1f17a49abc', type: 'directory', size: 18 },
      { path, type: 'file', size: 18 },
    ], usage: { usedBytes: 18, quotaBytes: 500 * 1024 * 1024, fileCount: 1 } });
    const onOpenFile = vi.fn();
    render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={onOpenFile} />);
    fireEvent.click(await screen.findByRole('button', { name: '展开 uploads' }));
    expect(screen.queryByRole('button', { name: /展开 uploads\/132a8d7c/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `打开 ${path}` }));
    expect(onOpenFile).toHaveBeenCalledWith(path);
  });

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
    expect(isProtectedWorkspacePath('threads/t1')).toBe(true);
    expect(isProtectedWorkspacePath('threads/t1/input')).toBe(true);
    expect(isProtectedWorkspacePath('threads/t1/notes.txt')).toBe(false);
    listWorkspaceFiles.mockResolvedValue({ files: personalFiles, usage });
    render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()}
      onAttachFile={vi.fn()} />);
    await screen.findByText(/已用 116 B/);
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }));
    expect(screen.getByRole('checkbox', { name: '选择 shared' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: '选择 uploads' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: '选择 threads' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '展开 threads' }));
    expect(screen.getByRole('checkbox', { name: '选择 threads/t1' })).toHaveProperty('disabled', true);
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


it('downloads the original file from its row menu without opening the preview', async () => {
  listWorkspaceFiles.mockResolvedValue({ files: personalFiles, usage });
  fetchWorkspaceFile.mockResolvedValue(new Blob(['original']));
  const create = vi.fn(() => 'blob:download');
  vi.stubGlobal('URL', { ...URL, createObjectURL: create, revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const open = vi.fn();
  render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={open} />);
  fireEvent.click(await screen.findByRole('button', { name: 'root.txt 的更多操作' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '下载' }));
  await waitFor(() => expect(click).toHaveBeenCalled());
  expect(fetchWorkspaceFile).toHaveBeenCalledWith('root.txt', 'personal');
  expect(open).not.toHaveBeenCalled();
  click.mockRestore();
  vi.unstubAllGlobals();
});


it('asks for a folder before uploading a workspace drop and never attaches it to chat', async () => {
  listWorkspaceFiles.mockResolvedValue({ files: personalFiles, usage });
  uploadWorkspaceFile.mockResolvedValue({ source: 'personal', path: 'docs/report.pptx', name: 'report.pptx' });
  const attach = vi.fn();
  const changed = vi.fn();
  render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()} onAttachFile={attach} onFilesChanged={changed} />);
  await screen.findByRole('button', { name: '展开 docs' });
  const file = new File(['pptx'], 'report.pptx');
  fireEvent.drop(screen.getByRole('button', { name: '展开 docs' }), { dataTransfer: { types: ['Files'], files: [file] } });
  const dialog = await screen.findByRole('dialog', { name: '上传到工作区' });
  expect(uploadWorkspaceFile).not.toHaveBeenCalled();
  expect(within(dialog).getByLabelText('目标目录')).toHaveProperty('value', 'docs');
  fireEvent.click(within(dialog).getByRole('button', { name: '开始上传' }));
  await waitFor(() => expect(uploadWorkspaceFile).toHaveBeenCalledWith(file, 'docs'));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(attach).not.toHaveBeenCalled();
});

describe('workspace file reveal', () => {
  it('expands ancestors, selects, and scrolls the target path', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    listWorkspaceFiles.mockResolvedValue({ files: [
      ...personalFiles,
      { path: 'threads/t1/output/中文 演示.pptx', type: 'file', size: 20 },
    ], usage });
    const path = 'threads/t1/output/中文 演示.pptx';
    const view = render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()}
      revealRequest={{ id: 1, path, source: 'personal', threadId: 't1' }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: `打开 ${path}` })).toBeTruthy());
    expect(screen.getByRole('button', { name: '收起 threads' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: '收起 threads/t1' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: '收起 threads/t1/output' }).getAttribute('aria-expanded')).toBe('true');
    const row = [...document.querySelectorAll('[data-workspace-path]')]
      .find((element) => element.getAttribute('data-workspace-path') === path);
    expect(row?.className).toContain('workspace-file-row--selected');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    view.rerender(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()}
      revealRequest={{ id: 2, path, source: 'personal', threadId: 't1' }} />);
    await waitFor(() => expect(scrollIntoView.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('reveals uploads files via the visible ancestor without showing UUID dirs', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const path = 'uploads/132a8d7c-c0bf-4f4f-93e2-6e1f17a49abc/report.html';
    listWorkspaceFiles.mockResolvedValue({ files: [
      { path: 'uploads', type: 'directory', size: 18 },
      { path: 'uploads/132a8d7c-c0bf-4f4f-93e2-6e1f17a49abc', type: 'directory', size: 18 },
      { path, type: 'file', size: 18 },
    ], usage: { usedBytes: 18, quotaBytes: 500 * 1024 * 1024, fileCount: 1 } });
    render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()}
      revealRequest={{ id: 1, path, source: 'personal', threadId: 't1' }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: `打开 ${path}` })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /展开 uploads\/132a8d7c/ })).toBeNull();
    expect(screen.getByRole('button', { name: '收起 uploads' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('ignores reveal requests for a mismatched source', async () => {
    listWorkspaceFiles.mockResolvedValue({ files: personalFiles, usage });
    render(<WorkspaceFileTree source="agent" workspaceId="ws" refreshVersion={0} onOpenFile={vi.fn()}
      revealRequest={{ id: 1, path: 'docs/note.txt', source: 'personal', threadId: 't1' }} />);
    await screen.findByRole('button', { name: '展开 docs' });
    expect(screen.queryByRole('button', { name: '打开 docs/note.txt' })).toBeNull();
  });

  it('shows an error when the revealed path is missing', async () => {
    listWorkspaceFiles.mockResolvedValue({ files: personalFiles, usage });
    render(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()}
      revealRequest={{ id: 1, path: 'missing/file.txt', source: 'personal', threadId: 't1' }} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '文件已不存在');
  });
});

it('waits for the newly selected source before consuming a reveal request', async () => {
  Element.prototype.scrollIntoView = vi.fn();
  let finish!: (result: unknown) => void;
  listWorkspaceFiles.mockResolvedValueOnce({ files: [{ path: 'old.txt', type: 'file', size: 1 }] })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<WorkspaceFileTree source="agent" workspaceId="old" refreshVersion={0} onOpenFile={vi.fn()} />);
  await screen.findByRole('button', { name: '打开 old.txt' });
  view.rerender(<WorkspaceFileTree source="personal" refreshVersion={0} onOpenFile={vi.fn()}
    revealRequest={{ id: 9, path: 'docs/note.txt', source: 'personal', threadId: 't1' }} />);
  expect(screen.queryByText('文件已不存在')).toBeNull();
  finish({ files: personalFiles, usage });
  const target = await screen.findByRole('button', { name: '打开 docs/note.txt' });
  expect(target.closest('li')?.className).toContain('workspace-file-row--selected');
});
