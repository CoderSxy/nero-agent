import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
import { drawingPlugin, officePlugin } from '@open-file-viewer/core';
import { FileViewer } from '@open-file-viewer/react';
import type { PreviewKind } from '../workspace-files';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import '@open-file-viewer/core/style.css';

pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
const plugins = [officePlugin(), drawingPlugin()];
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;

function useBlobUrl(blob: Blob) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => { URL.revokeObjectURL(created); setUrl(null); };
  }, [blob]);
  return url;
}

function PdfView({ url }: { url: string }) {
  const [pages, setPages] = useState(0);
  return <div className="workspace-pdf-preview" aria-label="PDF 预览">
    <Document file={url} loading={<p>正在加载 PDF…</p>} error={<p>PDF 解析失败，请下载查看。</p>}
      onLoadSuccess={document => setPages(document.numPages)}>
      {Array.from({ length: pages }, (_, index) => <Page key={index + 1} pageNumber={index + 1}
        width={Math.min(window.innerWidth - 400, 850)} renderTextLayer={false} renderAnnotationLayer={false} />)}
    </Document>
  </div>;
}

function PptxView({ blob }: { blob: Blob }) {
  const stage = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const target = stage.current;
    const scroller = scroll.current;
    if (!target || !scroller) return;
    const controller = new AbortController();
    let viewer: { destroy(): void } | null = null;
    void blob.arrayBuffer().then(async buffer => {
      const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer');
      const opened = await PptxViewer.open(buffer, target, { renderMode: 'list', fitMode: 'contain',
        scrollContainer: scroller, zipLimits: RECOMMENDED_ZIP_LIMITS, lazyMedia: true, lazySlides: true,
        pdfjs: false, signal: controller.signal, listOptions: { windowed: true, initialSlides: 3, batchSize: 6 } });
      if (controller.signal.aborted) opened.destroy(); else viewer = opened;
    }).catch(() => { if (!controller.signal.aborted) setError('PPTX 解析失败，请下载查看。'); });
    return () => { controller.abort(); viewer?.destroy(); };
  }, [blob]);
  return <div ref={scroll} className="workspace-pptx-preview">{error ? <p role="alert">{error}</p>
    : <div ref={stage} />}</div>;
}

export function ReadOnlyPreview({ name, kind, blob, onDownload }: {
  name: string; kind: PreviewKind; blob: Blob; onDownload(): void;
}) {
  const url = useBlobUrl(blob);
  const [error, setError] = useState<string | null>(null);
  if (blob.size > MAX_PREVIEW_BYTES || kind === 'unsupported') return <div className="workspace-preview-fallback">
    <p>{blob.size > MAX_PREVIEW_BYTES ? '文件超过 50 MB，无法在线预览。' : '该类型暂不支持在线预览。'}</p>
    <button type="button" onClick={onDownload}>下载文件</button>
  </div>;
  if (!url) return <p role="status">正在加载预览…</p>;
  if (kind === 'image') return <div className="workspace-image-preview"><img src={url} alt={name} /></div>;
  if (kind === 'pdf') return <PdfView url={url} />;
  if (kind === 'pptx') return <PptxView blob={blob} />;
  if (kind === 'office-drawing') return error ? <div className="workspace-preview-fallback" role="alert">
    <p>{error}</p><button type="button" onClick={onDownload}>下载文件</button></div>
    : <FileViewer file={new File([blob], name, { type: blob.type || 'application/octet-stream' })}
      fileName={name} width="100%" height="100%" fit="contain" toolbar theme="auto" locale="zh-CN"
      plugins={plugins} onError={() => setError('文件解析失败，请下载查看。')}
      onUnsupported={() => setError('该类型暂不支持在线预览。')} />;
  return <div className="workspace-preview-fallback"><p>该类型暂不支持在线预览。</p>
    <button type="button" onClick={onDownload}>下载文件</button></div>;
}
