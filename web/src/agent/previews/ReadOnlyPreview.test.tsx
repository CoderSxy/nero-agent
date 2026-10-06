import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadOnlyPreview } from './ReadOnlyPreview';

vi.mock('react-pdf', () => ({ Document: () => <div>PDF</div>, Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} } }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?worker&inline', () => ({ default: class {} }));
vi.mock('@open-file-viewer/core', () => ({ drawingPlugin: () => ({}), officePlugin: () => ({}) }));
vi.mock('@open-file-viewer/react', () => ({ FileViewer: () => <div>Office</div> }));

const createObjectURL = vi.fn(() => 'blob:preview');
const revokeObjectURL = vi.fn();
beforeEach(() => { vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('read-only preview', () => {
  it('releases object URLs when a preview closes', async () => {
    const view = render(<ReadOnlyPreview name="photo.png" kind="image" blob={new Blob(['image'])} onDownload={vi.fn()} />);
    expect(await screen.findByAltText('photo.png')).toBeTruthy();
    view.unmount();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview'));
  });

  it('offers download for unsupported binary files without Save', () => {
    render(<ReadOnlyPreview name="legacy.doc" kind="unsupported" blob={new Blob(['binary'])}
      onDownload={vi.fn()} />);
    expect(screen.getByRole('button', { name: '下载文件' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存文件' })).toBeNull();
  });
});
