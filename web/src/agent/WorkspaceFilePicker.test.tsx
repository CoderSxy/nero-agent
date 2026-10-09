import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFilePicker } from './WorkspaceFilePicker';

const listWorkspaceFiles = vi.fn();
vi.mock('./client', () => ({ listWorkspaceFiles: (...args: unknown[]) => listWorkspaceFiles(...args) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const files = [
  { path: 'docs', type: 'directory' as const, size: 0 },
  { path: 'docs/报告 中文.md', type: 'file' as const, size: 12 },
  { path: 'docs/nested', type: 'directory' as const, size: 0 },
  { path: 'docs/nested/报告 中文.md', type: 'file' as const, size: 20 },
  { path: 'uploads/a/notes.txt', type: 'file' as const, size: 8 },
];

describe('WorkspaceFilePicker', () => {
  it('lists files with tree sorting, expands directories, and searches by path or name', async () => {
    listWorkspaceFiles.mockResolvedValue({ files });
    render(<WorkspaceFilePicker source="personal" onConfirm={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: '选择工作区文件' })).toBeTruthy());
    expect(listWorkspaceFiles).toHaveBeenCalledWith('personal');
    expect(screen.getByText('docs')).toBeTruthy();
    expect(screen.queryByText('报告 中文.md')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开 docs' }));
    expect(screen.getAllByText('报告 中文.md').length).toBeGreaterThanOrEqual(1);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索文件' }), { target: { value: 'nested/报告' } });
    expect(screen.getByText('docs/nested/报告 中文.md')).toBeTruthy();
    expect(screen.queryByText('uploads/a/notes.txt')).toBeNull();
  });

  it('confirms only selected regular files and deduplicates paths', async () => {
    listWorkspaceFiles.mockResolvedValue({ files });
    const onConfirm = vi.fn();
    render(<WorkspaceFilePicker source="personal" onConfirm={onConfirm} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('docs')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '展开 docs' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 docs/报告 中文.md' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 docs/报告 中文.md' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 docs/报告 中文.md' }));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(onConfirm).toHaveBeenCalledWith(['docs/报告 中文.md']);
  });

  it('cancels without submitting and ignores directory selection', async () => {
    listWorkspaceFiles.mockResolvedValue({ files });
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<WorkspaceFilePicker source="personal" onConfirm={onConfirm} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('docs')).toBeTruthy());
    expect(screen.queryByRole('checkbox', { name: '选择 docs' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps same-name files at different paths as separate selections', async () => {
    listWorkspaceFiles.mockResolvedValue({ files });
    const onConfirm = vi.fn();
    render(<WorkspaceFilePicker source="personal" onConfirm={onConfirm} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('docs')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '展开 docs' }));
    fireEvent.click(screen.getByRole('button', { name: '展开 docs/nested' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 docs/报告 中文.md' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 docs/nested/报告 中文.md' }));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(onConfirm).toHaveBeenCalledWith(['docs/报告 中文.md', 'docs/nested/报告 中文.md']);
  });
});
