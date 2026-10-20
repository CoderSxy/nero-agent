import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillApiError, listAvailableSkills, listManageableSkills, saveDraft } from './skills-api';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('skills-api', () => {
  it('lists manageable skills with search pagination and group', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], total: 0, page: 2, pageSize: 20 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await listManageableSkills({ page: 2, pageSize: 20, q: 'demo', groupId: 'g1' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/agent-skills?');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('page=2');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('q=demo');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('groupId=g1');
  });

  it('sends expectedRevision on draft save and surfaces 409', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'REVISION_CONFLICT', message: 'revision mismatch' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(saveDraft('skill-1', { expectedRevision: '3', skillMd: '# x' }))
      .rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' } satisfies Partial<SkillApiError>);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toBeTruthy();
    const headers = new Headers(init.headers);
    expect(headers.get('If-Match')).toBe('"3"');
    expect(JSON.parse(String(init.body))).toMatchObject({ expectedRevision: '3', skillMd: '# x' });
  });

  it('forwards an optional abort signal without changing the available URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], total: 0, page: 1, pageSize: 50 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await listAvailableSkills({ page: 1, pageSize: 50, q: '天气' }, controller.signal);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/agent-skills/available?');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('q=%E5%A4%A9%E6%B0%94');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
  });
});
