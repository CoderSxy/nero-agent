export type ComposerAttachment = {
  key: string;
  source: 'personal' | 'agent';
  path: string;
  name: string;
  size: number;
  mimeType: string;
  etag: string;
  state: 'uploading' | 'ready' | 'failed';
  error?: string;
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
export const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function isImageAttachment(attachment: Pick<ComposerAttachment, 'mimeType' | 'name'>): boolean {
  if (IMAGE_MIME.has(attachment.mimeType)) return true;
  return /\.(png|jpe?g|webp|gif)$/i.test(attachment.name);
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}
