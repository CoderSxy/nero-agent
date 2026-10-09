import { MastraClient } from '@mastra/client-js';

export const AGENT_ID = 'agent';
export let client = new MastraClient({ baseUrl: '', apiPrefix: '/api' });

let currentToken: string | null = null;

export function setAgentClientToken(token: string | null) {
  currentToken = token;
  client = new MastraClient({ baseUrl: '', apiPrefix: '/api',
    headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (currentToken) headers.set('Authorization', `Bearer ${currentToken}`);
  else headers.delete('Authorization');
  return fetch(path, { ...init, headers });
}

export function userFileUrl(threadId: string, relativePath: string): string {
  return `/user-files/${threadId}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

export type UserFileEntry = { path: string; type: 'file' | 'directory'; size: number };
export type WorkspaceUsage = { usedBytes: number; quotaBytes: number; fileCount: number };
export type WorkspaceFileEntry = {
  source: 'personal';
  path: string;
  name: string;
  size: number;
  mimeType: string;
  etag: string;
};

export async function listUserFiles(threadId: string): Promise<UserFileEntry[]> {
  const response = await apiFetch(`/user-files/${encodeURIComponent(threadId)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? '加载文件失败');
  }
  const body = await response.json() as { files?: UserFileEntry[] };
  if (!Array.isArray(body.files)) throw new Error('文件列表格式无效');
  return body.files;
}

export async function listWorkspaceFiles(source: 'personal' | 'agent' = 'personal',
  expectedWorkspaceId?: string): Promise<{ files: UserFileEntry[]; usage?: WorkspaceUsage }> {
  const response = await apiFetch(source === 'agent'
    ? '/current-workspace/files?source=agent' : '/current-workspace/files');
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? '加载工作区文件失败');
  }
  if (response.headers.get('content-type')?.includes('text/html')) {
    throw new Error('工作区接口返回了 HTML，请检查开发服务器代理');
  }
  const body = await response.json() as {
    workspaceId?: string; files?: UserFileEntry[]; usage?: WorkspaceUsage;
  };
  if ((expectedWorkspaceId && body.workspaceId !== expectedWorkspaceId) || !Array.isArray(body.files))
    throw new Error('工作区文件列表与当前用户不匹配');
  return { files: body.files, usage: body.usage };
}

export async function uploadWorkspaceFile(file: File): Promise<WorkspaceFileEntry> {
  const body = new FormData();
  body.set('file', file);
  const response = await apiFetch('/current-workspace/upload', { method: 'POST', body });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
    const error = new Error(payload.error ?? '上传失败') as Error & { code?: string };
    error.code = payload.code;
    throw error;
  }
  return response.json() as Promise<WorkspaceFileEntry>;
}

export async function fetchWorkspaceFile(relativePath: string,
  source: 'personal' | 'agent' = 'personal'): Promise<Blob> {
  const path = relativePath.split('/').map(encodeURIComponent).join('/');
  const response = await apiFetch(`/current-workspace/files/${path}${source === 'agent' ? '?source=agent' : ''}`);
  if (!response.ok) throw new Error('下载失败或无权访问该文件');
  return response.blob();
}

export async function fetchUserFile(threadId: string, relativePath: string): Promise<Blob> {
  const response = await apiFetch(userFileUrl(threadId, relativePath));
  if (!response.ok) throw new Error('下载失败或无权访问该文件');
  return response.blob();
}

export async function uploadUserFile(threadId: string, relativePath: string, file: File): Promise<{ path: string }> {
  const body = new FormData();
  body.set('threadId', threadId);
  body.set('path', relativePath);
  body.set('file', file);
  const response = await apiFetch('/user-files/upload', { method: 'POST', body });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: '上传失败' })) as { error?: string }).error ?? '上传失败');
  return response.json() as Promise<{ path: string }>;
}
