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
