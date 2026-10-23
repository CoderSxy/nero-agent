import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceUploadDialog } from './WorkspaceUploadDialog';
const listWorkspaceFiles = vi.fn();
const uploadWorkspaceFile = vi.fn();
vi.mock('./client', () => ({
  listWorkspaceFiles: (...args: unknown[]) => listWorkspaceFiles(...args),
  uploadWorkspaceFile: (...args: unknown[]) => uploadWorkspaceFile(...args),
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('retries only failed files after a partial upload and keeps the chosen directory', async () => {
  listWorkspaceFiles.mockResolvedValue({ files: [{ path: 'projects', type: 'directory' }] });
  uploadWorkspaceFile.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce({});
  const close = vi.fn();
  const uploaded = vi.fn();
  const first = new File(['1'], 'first.txt'); const second = new File(['2'], 'second.txt');
  render(<WorkspaceUploadDialog files={[first, second]} onClose={close} onFileUploaded={uploaded} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '开始上传' })).toHaveProperty('disabled', false));
  fireEvent.change(screen.getByLabelText('目标目录'), { target: { value: 'projects' } });
  fireEvent.click(screen.getByRole('button', { name: '开始上传' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '网络中断');
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText('目标目录')).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: '重试失败文件' }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(uploadWorkspaceFile.mock.calls).toEqual([[first, 'projects'], [second, 'projects'], [second, 'projects']]);
  expect(uploaded).toHaveBeenCalledTimes(2);
});

it('cancel and Escape never upload a file or attach it', async () => {
  listWorkspaceFiles.mockResolvedValue({ files: [] });
  const close = vi.fn(); const confirm = vi.fn();
  render(<WorkspaceUploadDialog files={[new File(['x'], 'a.txt')]} onClose={close} onConfirm={confirm} />);
  const dialog = await screen.findByRole('dialog', { name: '上传到工作区' });
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
  expect(uploadWorkspaceFile).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(close).toHaveBeenCalledTimes(2);
});
