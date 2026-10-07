import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFileOverlay } from './WorkspaceFileOverlay';

const openWorkspaceFile = vi.fn();
const saveWorkspaceFile = vi.fn();
vi.mock('./workspace-files', () => ({ openWorkspaceFile: (...args: unknown[]) => openWorkspaceFile(...args),
  saveWorkspaceFile: (...args: unknown[]) => saveWorkspaceFile(...args) }));
vi.mock('./previews/TextEditor', () => ({ TextEditor: ({ value, onChange }: {
  value: string; onChange(value: string): void;
}) => <textarea aria-label="文件内容" value={value} onChange={event => onChange(event.target.value)} /> }));
vi.mock('./previews/ReadOnlyPreview', () => ({ ReadOnlyPreview: () => <div>只读预览</div> }));

function opened(text = 'old', kind = 'text') {
  return { blob: new Blob([text]), etag: '"v1"', kind, text: kind === 'text' ? text : undefined };
}

beforeEach(() => {
  openWorkspaceFile.mockResolvedValue(opened());
  saveWorkspaceFile.mockResolvedValue('"v2"');
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function overlay(onClosed = vi.fn(), onSaved = vi.fn()) {
  const view = render(<WorkspaceFileOverlay request={{ path: 'note.txt', id: 1 }} source="personal"
    onClosed={onClosed} onSaved={onSaved} />);
  return { view, onClosed, onSaved };
}

describe('workspace file overlay', () => {
  it('edits text, saves with its ETag and then closes cleanly', async () => {
    const { onClosed, onSaved } = overlay();
    fireEvent.change(await screen.findByRole('textbox', { name: '文件内容' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
    await waitFor(() => expect(saveWorkspaceFile).toHaveBeenCalledWith('note.txt', 'personal', 'new', '"v1"'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '关闭文件' }));
    expect(onClosed).toHaveBeenCalled();
  });

  it('offers save, discard and continue for a dirty file', async () => {
    const { onClosed } = overlay();
    fireEvent.change(await screen.findByRole('textbox', { name: '文件内容' }), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭文件' }));
    expect(screen.getByRole('dialog', { name: '未保存的修改' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect((screen.getByRole('textbox', { name: '文件内容' }) as HTMLTextAreaElement).value).toBe('draft');
    fireEvent.click(screen.getByRole('button', { name: '关闭文件' }));
    fireEvent.click(screen.getByRole('button', { name: '放弃修改并关闭' }));
    expect(onClosed).toHaveBeenCalled();
    expect(saveWorkspaceFile).not.toHaveBeenCalled();
  });

  it('saves and closes from the unsaved confirmation', async () => {
    const { onClosed } = overlay();
    fireEvent.change(await screen.findByRole('textbox', { name: '文件内容' }), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭文件' }));
    fireEvent.click(screen.getByRole('button', { name: '保存并关闭' }));
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    expect(saveWorkspaceFile).toHaveBeenCalledWith('note.txt', 'personal', 'draft', '"v1"');
  });

  it('keeps edits made during a pending save unsaved', async () => {
    let resolveSave!: (etag: string) => void;
    saveWorkspaceFile.mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; }));
    const { onClosed } = overlay();
    const editor = await screen.findByRole('textbox', { name: '文件内容' });
    fireEvent.change(editor, { target: { value: 'submitted' } });
    fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
    await waitFor(() => expect(saveWorkspaceFile).toHaveBeenCalledWith('note.txt', 'personal', 'submitted', '"v1"'));
    fireEvent.change(editor, { target: { value: 'newer draft' } });
    resolveSave('"v2"');
    await waitFor(() => expect(screen.getByRole('button', { name: '保存文件' }).hasAttribute('disabled')).toBe(false));
    expect(screen.getByText('未保存')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭文件' }));
    expect(screen.getByRole('dialog', { name: '未保存的修改' })).toBeTruthy();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('continues to the latest file selected while saving a dirty file', async () => {
    let resolveSave!: (etag: string) => void;
    saveWorkspaceFile.mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; }));
    const onClosed = vi.fn(); const onSaved = vi.fn();
    const { view } = overlay(onClosed, onSaved);
    fireEvent.change(await screen.findByRole('textbox', { name: '文件内容' }), { target: { value: 'draft' } });
    view.rerender(<WorkspaceFileOverlay request={{ path: 'other.md', id: 2 }} source="personal"
      onClosed={onClosed} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }));
    await waitFor(() => expect(saveWorkspaceFile).toHaveBeenCalledTimes(1));
    view.rerender(<WorkspaceFileOverlay request={{ path: 'latest.md', id: 3 }} source="personal"
      onClosed={onClosed} onSaved={onSaved} />);
    resolveSave('"v2"');
    await waitFor(() => expect(openWorkspaceFile).toHaveBeenCalledWith('latest.md', 'personal'));
    expect(openWorkspaceFile).not.toHaveBeenCalledWith('other.md', 'personal');
  });

  it('keeps a draft on save conflict and switches files only after the choice', async () => {
    saveWorkspaceFile.mockRejectedValue(new Error('文件已被修改'));
    const { view } = overlay();
    fireEvent.change(await screen.findByRole('textbox', { name: '文件内容' }), { target: { value: 'draft' } });
    view.rerender(<WorkspaceFileOverlay request={{ path: 'other.md', id: 2 }} source="personal"
      onClosed={vi.fn()} onSaved={vi.fn()} />);
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '文件已被修改');
    expect((screen.getByRole('textbox', { name: '文件内容' }) as HTMLTextAreaElement).value).toBe('draft');
    expect(openWorkspaceFile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '放弃修改并继续' }));
    await waitFor(() => expect(openWorkspaceFile).toHaveBeenCalledWith('other.md', 'personal'));
  });

  it('hides Save for binary files and ignores stale load responses', async () => {
    let resolveFirst!: (value: ReturnType<typeof opened>) => void;
    openWorkspaceFile.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(opened('pdf bytes', 'pdf'));
    const { view } = overlay();
    view.rerender(<WorkspaceFileOverlay request={{ path: 'report.pdf', id: 2 }} source="personal"
      onClosed={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText('只读预览')).toBeTruthy();
    resolveFirst(opened('stale'));
    expect(screen.queryByRole('button', { name: '保存文件' })).toBeNull();
    expect(screen.getAllByText('report.pdf').length).toBeGreaterThan(0);
  });
});
