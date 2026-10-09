import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentComposer } from './AgentComposer';
import type { ComposerAttachment } from './attachment-types';
import type { SafeModel } from './model-catalog-client';

const fetchWorkspaceFile = vi.fn();
vi.mock('./client', () => ({
  fetchWorkspaceFile: (...args: unknown[]) => fetchWorkspaceFile(...args),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const readyFile = (overrides: Partial<ComposerAttachment> = {}): ComposerAttachment => ({
  key: 'f1', source: 'personal', path: 'uploads/a/notes.txt', name: 'notes.txt',
  size: 12, mimeType: 'text/plain', etag: 'e1', state: 'ready', ...overrides,
});

describe('Composer run controls', () => {
  it('shows the selected default model at bottom left and icon send control at bottom right', () => {
    const first = 'public:11111111-1111-4111-8111-111111111111';
    const second = 'private:22222222-2222-4222-8222-222222222222';
    const catalog = [first, second].map((ref, index) => ({
      ref, scope: index === 0 ? 'public' : 'private', displayName: index === 0 ? '默认模型' : '个人模型',
      providerId: 'test', modelId: `m${index}`, enabled: true, baseUrl: 'https://example.test',
      apiMode: 'chat', hasApiKey: true, keyHint: '1234', supportsVision: false,
    })) as SafeModel[];
    const change = vi.fn();
    const { container } = render(<AgentComposer draft="测试" onDraftChange={vi.fn()} isRunning={false}
      onSend={vi.fn()} onStop={vi.fn()} catalog={catalog} modelRef={first} onModelChange={change} />);
    const actions = container.querySelector('[data-slot="composer-actions"]')!;
    const select = screen.getByRole('combobox', { name: '模型' });
    const send = screen.getByRole('button', { name: '发送' });
    expect(actions.firstElementChild).toBe(select);
    expect(actions.lastElementChild?.lastElementChild).toBe(send);
    expect(screen.getByRole('button', { name: '添加附件' }).nextElementSibling).toBe(send);
    expect(select.textContent).toContain('默认模型');
    expect(send.querySelector('svg')).toBeTruthy();
    expect(send.textContent).toBe('');
    fireEvent.click(select);
    expect(screen.getByRole('listbox', { name: '选择模型' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: '个人' } });
    expect(screen.queryByRole('option', { name: /默认模型/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /个人模型/ }));
    expect(change).toHaveBeenCalledWith(second);
  });
  it('prevents duplicate sends while a run is active and exposes stop', () => {
    const send = vi.fn(); const stop = vi.fn();
    render(<AgentComposer draft="测试" onDraftChange={vi.fn()} isRunning={true} onSend={send} onStop={stop} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '发送消息' }), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('Composer attachment menu and cards', () => {
  it('opens a three-option add menu without a context module', () => {
    const onUploadFiles = vi.fn();
    const onChooseWorkspaceFiles = vi.fn();
    render(<AgentComposer draft="" onDraftChange={vi.fn()} isRunning={false} onSend={vi.fn()} onStop={vi.fn()}
      onUploadFiles={onUploadFiles} onChooseWorkspaceFiles={onChooseWorkspaceFiles} />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    const menu = screen.getByRole('menu', { name: '添加附件' });
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(item => item.textContent);
    expect(items).toEqual(['上传文件', '选择工作区文件', '添加图片']);
    expect(items).not.toContain('上下文');
    fireEvent.click(screen.getByRole('menuitem', { name: '选择工作区文件' }));
    expect(onChooseWorkspaceFiles).toHaveBeenCalledTimes(1);
  });

  it('renders file and image cards with remove actions and blocks send while uploading or failed', async () => {
    fetchWorkspaceFile.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    const createObjectURL = vi.fn(() => 'blob:preview-shot');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const onRemove = vi.fn();
    const onSend = vi.fn();
    const onRetry = vi.fn();
    const attachments: ComposerAttachment[] = [
      readyFile({ key: 'a', name: '报告 中文.md', path: 'docs/报告 中文.md' }),
      readyFile({ key: 'b', name: 'shot.png', path: 'uploads/b/shot.png', mimeType: 'image/png' }),
      readyFile({ key: 'c', name: 'uploading.bin', state: 'uploading', path: '', etag: '' }),
    ];
    const { rerender, unmount } = render(<AgentComposer draft="你好" onDraftChange={vi.fn()} isRunning={false}
      onSend={onSend} onStop={vi.fn()} attachments={attachments} onRemoveAttachment={onRemove}
      onRetryAttachment={onRetry} />);
    expect(screen.getByLabelText('附件 报告 中文.md')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('img', { name: 'shot.png' })).toBeTruthy());
    expect(fetchWorkspaceFile).toHaveBeenCalledWith('uploads/b/shot.png', 'personal');
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '从本次消息移除 报告 中文.md' }));
    expect(onRemove).toHaveBeenCalledWith('a');
    fireEvent.click(screen.getByRole('button', { name: '预览 shot.png' }));
    expect(screen.getByRole('dialog', { name: '图片预览' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
    expect(screen.queryByRole('dialog', { name: '图片预览' })).toBeNull();

    rerender(<AgentComposer draft="你好" onDraftChange={vi.fn()} isRunning={false}
      onSend={onSend} onStop={vi.fn()} attachments={[readyFile({ key: 'f', state: 'failed', error: '上传失败' })]}
      onRemoveAttachment={onRemove} onRetryAttachment={onRetry} />);
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重试 notes.txt' }));
    expect(onRetry).toHaveBeenCalledWith('f');
    unmount();
    expect(revokeObjectURL).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('forwards multi-file and image picks through dedicated inputs', () => {
    const onUploadFiles = vi.fn();
    render(<AgentComposer draft="" onDraftChange={vi.fn()} isRunning={false} onSend={vi.fn()} onStop={vi.fn()}
      onUploadFiles={onUploadFiles} />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '上传文件' }));
    const fileInput = screen.getByLabelText('选择本地文件') as HTMLInputElement;
    expect(fileInput.multiple).toBe(true);
    const files = [
      new File(['a'], '报告 中文.md', { type: 'text/markdown' }),
      new File(['b'], 'notes.txt', { type: 'text/plain' }),
    ];
    fireEvent.change(fileInput, { target: { files } });
    expect(onUploadFiles).toHaveBeenCalledWith(files, 'file');

    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '添加图片' }));
    const imageInput = screen.getByLabelText('选择图片') as HTMLInputElement;
    expect(imageInput.accept).toContain('image/png');
    const images = [new File(['i'], 'shot.png', { type: 'image/png' })];
    fireEvent.change(imageInput, { target: { files: images } });
    expect(onUploadFiles).toHaveBeenCalledWith(images, 'image');
  });

  it('shows same-name files from different paths as separate cards', () => {
    render(<AgentComposer draft="x" onDraftChange={vi.fn()} isRunning={false} onSend={vi.fn()} onStop={vi.fn()}
      attachments={[
        readyFile({ key: '1', path: 'docs/报告.md', name: '报告.md' }),
        readyFile({ key: '2', path: 'uploads/a/报告.md', name: '报告.md' }),
      ]} />);
    expect(screen.getAllByText('报告.md')).toHaveLength(2);
    expect(screen.getByTitle('docs/报告.md')).toBeTruthy();
    expect(screen.getByTitle('uploads/a/报告.md')).toBeTruthy();
  });
});
