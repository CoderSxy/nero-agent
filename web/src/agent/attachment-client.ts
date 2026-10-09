import {
  apiFetch,
  listThreadAttachments as fetchThreadAttachments,
  uploadWorkspaceFile as postWorkspaceFile,
  type WorkspaceFileEntry,
} from './client';

export type AttachmentPrepareItem = { source: 'personal' | 'agent'; path: string };

export type PreparedAttachment = {
  attachmentId: string;
  clientMessageId: string;
  source: 'personal' | 'agent';
  path: string;
  name: string;
  size: number;
  mimeType: string;
  etag: string;
  status: 'available' | 'changed' | 'deleted';
};

export async function uploadWorkspaceFile(
  file: File,
  onProgress?: (ratio: number) => void,
): Promise<WorkspaceFileEntry> {
  onProgress?.(0);
  const result = await postWorkspaceFile(file);
  onProgress?.(1);
  return result;
}

export async function prepareAttachments(
  threadId: string,
  clientMessageId: string,
  items: AttachmentPrepareItem[],
): Promise<PreparedAttachment[]> {
  const response = await apiFetch('/current-workspace/attachments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, clientMessageId, items }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? '准备附件失败');
  }
  const body = await response.json() as { attachments?: PreparedAttachment[] };
  if (!Array.isArray(body.attachments)) throw new Error('附件响应格式无效');
  return body.attachments;
}

export async function listThreadAttachments(
  threadId: string,
  signal?: AbortSignal,
): Promise<PreparedAttachment[]> {
  return fetchThreadAttachments(threadId, signal);
}
