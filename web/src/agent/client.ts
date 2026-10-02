import { MastraClient } from '@mastra/client-js';

export const AGENT_ID = 'agent';
export let client = new MastraClient({ baseUrl: '', apiPrefix: '/api' });

export function setAgentClientToken(token: string | null) {
  client = new MastraClient({ baseUrl: '', apiPrefix: '/api',
    headers: token ? { Authorization: `Bearer ${token}` } : {} });
}
