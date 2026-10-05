import { afterEach, expect, it, vi } from 'vitest';
import { fetchUserFile, setAgentClientToken } from './client';

afterEach(() => {
  setAgentClientToken(null);
  vi.unstubAllGlobals();
});

it('downloads a private file with the bearer token', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('file contents', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  setAgentClientToken('secret-session');
  const blob = await fetchUserFile('thread-1', 'output/report.txt');
  expect(await blob.text()).toBe('file contents');
  expect(fetch).toHaveBeenCalledWith('/user-files/thread-1/output/report.txt', expect.objectContaining({
    headers: expect.any(Headers),
  }));
  expect((fetch.mock.calls[0][1].headers as Headers).get('Authorization')).toBe('Bearer secret-session');
});
