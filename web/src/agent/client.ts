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
  return `/api/user-files/${threadId}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

export async function uploadUserFile(threadId: string, relativePath: string, file: File): Promise<{ path: string }> {
  const body = new FormData();
  body.set('threadId', threadId);
  body.set('path', relativePath);
  body.set('file', file);
  const response = await apiFetch('/api/user-files/upload', { method: 'POST', body });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: '上传失败' })) as { error?: string }).error ?? '上传失败');
  return response.json() as Promise<{ path: string }>;
}
