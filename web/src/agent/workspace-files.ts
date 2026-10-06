import { apiFetch } from './client';

export type WorkspaceSource = 'personal' | 'agent';
export type PreviewKind = 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'pptx' | 'office-drawing' | 'unsupported';
export type OpenWorkspaceFile = { blob: Blob; etag: string | null; kind: PreviewKind; text?: string };

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const extensions = {
  image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']),
  office: new Set(['docx', 'xlsx', 'drawio', 'dio']),
};

export function workspaceFilePath(path: string, source: WorkspaceSource): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `/current-workspace/files/${encoded}${source === 'agent' ? '?source=agent' : ''}`;
}

function knownKind(path: string): PreviewKind | null {
  const extension = path.split('/').at(-1)?.split('.').at(-1)?.toLowerCase() ?? '';
  if (extensions.image.has(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'pptx') return 'pptx';
  if (extensions.office.has(extension)) return 'office-drawing';
  if (['doc', 'xls', 'ppt'].includes(extension)) return 'unsupported';
  return null;
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? fallback;
}

export async function openWorkspaceFile(path: string, source: WorkspaceSource): Promise<OpenWorkspaceFile> {
  const response = await apiFetch(workspaceFilePath(path, source));
  if (!response.ok) throw new Error(await errorMessage(response, '读取文件失败'));
  const blob = await response.blob();
  const etag = response.headers.get('etag');
  const fixedKind = knownKind(path);
  if (fixedKind) return { blob, etag, kind: fixedKind };
  if (blob.size > MAX_TEXT_BYTES) return { blob, etag, kind: 'unsupported' };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.includes(0)) return { blob, etag, kind: 'unsupported' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { blob, etag, kind: 'unsupported' }; }
  const extension = path.split('.').at(-1)?.toLowerCase();
  const kind = extension === 'md' || extension === 'markdown' ? 'markdown'
    : extension === 'html' || extension === 'htm' ? 'html' : 'text';
  return { blob, etag, kind, text };
}

export async function saveWorkspaceFile(path: string, source: WorkspaceSource, text: string,
  etag: string): Promise<string> {
  const response = await apiFetch(workspaceFilePath(path, source), { method: 'PUT',
    headers: { 'content-type': 'text/plain; charset=utf-8', 'if-match': etag }, body: text });
  if (!response.ok) throw new Error(await errorMessage(response, '保存文件失败'));
  const next = response.headers.get('etag');
  if (!next) throw new Error('保存成功但服务器未返回文件版本');
  return next;
}
