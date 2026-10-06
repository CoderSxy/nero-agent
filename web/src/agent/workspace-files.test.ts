import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentClientToken } from './client';
import { openWorkspaceFile, saveWorkspaceFile, workspaceFilePath } from './workspace-files';

afterEach(() => { setAgentClientToken(null); vi.unstubAllGlobals(); });

describe('workspace file client', () => {
  it('encodes each path segment and keeps the source separate', () => {
    expect(workspaceFilePath('a b/#中%25.md', 'agent'))
      .toBe('/current-workspace/files/a%20b/%23%E4%B8%AD%2525.md?source=agent');
  });

  it('classifies text, unknown UTF-8, and binary without exposing a file URL', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('# Hello', { headers: { etag: '"v1"' } }))
      .mockResolvedValueOnce(new Response('hello'))
      .mockResolvedValueOnce(new Response(new Uint8Array([0, 1, 2])));
    vi.stubGlobal('fetch', fetch);
    setAgentClientToken('secret');
    const md = await openWorkspaceFile('note.md', 'personal');
    expect(md).toMatchObject({ kind: 'markdown', text: '# Hello', etag: '"v1"' });
    expect((fetch.mock.calls[0][1].headers as Headers).get('Authorization')).toBe('Bearer secret');
    expect((await openWorkspaceFile('README', 'personal')).kind).toBe('text');
    expect((await openWorkspaceFile('unknown.bin', 'personal')).kind).toBe('unsupported');
  });

  it('marks preview formats read only and passes the original ETag to save', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { etag: '"pdf"' } }))
      .mockResolvedValueOnce(new Response('{}', { headers: { etag: '"new"' } }));
    vi.stubGlobal('fetch', fetch);
    expect((await openWorkspaceFile('report.pdf', 'agent')).kind).toBe('pdf');
    expect(await saveWorkspaceFile('a b/note.md', 'personal', '# New', '"old"')).toBe('"new"');
    expect(fetch.mock.calls[1][0]).toBe('/current-workspace/files/a%20b/note.md');
    expect(fetch.mock.calls[1][1].method).toBe('PUT');
    expect((fetch.mock.calls[1][1].headers as Headers).get('If-Match')).toBe('"old"');
  });

  it('reports a version conflict while leaving the draft with the caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '文件已修改' }),
      { status: 412, headers: { 'content-type': 'application/json' } })));
    await expect(saveWorkspaceFile('note.md', 'personal', 'draft', '"old"')).rejects.toThrow('文件已修改');
  });
});
