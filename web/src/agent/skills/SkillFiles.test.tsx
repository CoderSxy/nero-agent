import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillFiles } from './SkillFiles';

afterEach(cleanup);

describe('SkillFiles', () => {
  it('renders resource tree and supports binary upload download delete', () => {
    const onUpload = vi.fn();
    const onDelete = vi.fn();
    const onDownload = vi.fn();
    render(<SkillFiles
      files={[
        { skillId: 's1', version: 1, path: 'references/a.md', blobHash: 'h1', size: 12, mimeType: 'text/markdown', isText: true },
        { skillId: 's1', version: 1, path: 'assets/data.bin', blobHash: 'h2', size: 4, mimeType: 'application/octet-stream', isText: false },
      ]}
      version={1}
      canEdit
      busy={false}
      onUpload={onUpload}
      onDelete={onDelete}
      onDownload={onDownload}
    />);
    expect(screen.getByText('references/a.md')).toBeTruthy();
    expect(screen.getByText(/二进制/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '下载' })[1]!);
    expect(onDownload).toHaveBeenCalledWith('assets/data.bin', false);
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]!);
    expect(onDelete).toHaveBeenCalledWith('references/a.md');

    const file = new File([new Uint8Array([1, 2, 3])], 'data.bin', { type: 'application/octet-stream' });
    fireEvent.change(screen.getByLabelText('上传路径'), { target: { value: 'assets/data.bin' } });
    fireEvent.change(screen.getByLabelText('选择上传文件'), { target: { files: [file] } });
    expect(onUpload).toHaveBeenCalledWith('assets/data.bin', file);
  });
});
