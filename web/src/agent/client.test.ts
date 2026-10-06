import { afterEach, expect, it, vi } from 'vitest';
import { fetchUserFile, fetchWorkspaceFile, listUserFiles, listWorkspaceFiles, setAgentClientToken } from './client';

afterEach(() => {
  setAgentClientToken(null);
  vi.unstubAllGlobals();
});

it('downloads a private file with the bearer token', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('file contents', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  setAgentClientToken('secret-session');
  const blob = await fetchUserFile('thread-1', 'output/report.txt');
  const content = await blob.text();
  expect(content).toBe('file contents');
  expect(fetch).toHaveBeenCalledWith('/user-files/thread-1/output/report.txt', expect.objectContaining({
    headers: expect.any(Headers),
  }));
  expect((fetch.mock.calls[0][1].headers as Headers).get('Authorization')).toBe('Bearer secret-session');
});

it('lists only the selected thread files with the bearer token', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ files: [
    { path: 'output/report.md', type: 'file', size: 12 },
  ] }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  setAgentClientToken('secret-session');
  expect(await listUserFiles('thread-1')).toEqual([{ path: 'output/report.md', type: 'file', size: 12 }]);
  expect(fetch).toHaveBeenCalledWith('/user-files/thread-1', expect.objectContaining({
    headers: expect.any(Headers),
  }));
  expect((fetch.mock.calls[0][1].headers as Headers).get('Authorization')).toBe('Bearer secret-session');
});

it('lists the authenticated user workspace without a client-supplied id', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspaceId: 'ws-user',
    files: [{ path: 'created.md', type: 'file', size: 8 }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  setAgentClientToken('secret-session');
  expect(await listWorkspaceFiles()).toEqual([{ path: 'created.md', type: 'file', size: 8 }]);
  expect(fetch).toHaveBeenCalledWith('/current-workspace/files', expect.anything());
});

it('lists the Agent workspace only through its explicit source', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspaceId: 'agent-workspace',
    files: [{ path: 'legacy.md', type: 'file', size: 8 }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  expect(await listWorkspaceFiles('agent', 'agent-workspace'))
    .toEqual([{ path: 'legacy.md', type: 'file', size: 8 }]);
  expect(fetch).toHaveBeenCalledWith('/current-workspace/files?source=agent', expect.anything());
});

it('reports an HTML workspace response as a routing error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<!doctype html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  })));
  await expect(listWorkspaceFiles('agent')).rejects.toThrow('工作区接口返回了 HTML，请检查开发服务器代理');
});

it('downloads a nested Agent workspace file with an encoded path and bearer token', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('# 文件', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  setAgentClientToken('secret-session');
  expect(await (await fetchWorkspaceFile('docs/中文 文档.md', 'agent')).text()).toBe('# 文件');
  expect(fetch).toHaveBeenCalledWith('/current-workspace/files/docs/%E4%B8%AD%E6%96%87%20%E6%96%87%E6%A1%A3.md?source=agent',
    expect.objectContaining({ headers: expect.any(Headers) }));
  expect((fetch.mock.calls[0][1].headers as Headers).get('Authorization')).toBe('Bearer secret-session');
});
