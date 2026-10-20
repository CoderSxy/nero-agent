import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentShellContextValue } from '../AgentShell';
import { SkillsPage } from './SkillsPage';
import { SkillApiError } from './skills-api';
import type { SkillManageDetail, SkillManageListItem } from './types';

const listManageableSkills = vi.fn();
const createSkill = vi.fn();
const getSkillDetail = vi.fn();
const saveDraft = vi.fn();
const createWorkingDraft = vi.fn();
const listSkillFiles = vi.fn();
const listSkillVersions = vi.fn();
const listSkillGroups = vi.fn();
const publishSkill = vi.fn();
const rollbackSkill = vi.fn();
const enableSkill = vi.fn();
const disableSkill = vi.fn();
const uploadDraftFile = vi.fn();
const deleteDraftFile = vi.fn();
const downloadSkillFile = vi.fn();
const patchSkillMetadata = vi.fn();

vi.mock('./skills-api', async () => {
  const actual = await vi.importActual<typeof import('./skills-api')>('./skills-api');
  return {
    ...actual,
    listManageableSkills: (...args: unknown[]) => listManageableSkills(...args),
    createSkill: (...args: unknown[]) => createSkill(...args),
    getSkillDetail: (...args: unknown[]) => getSkillDetail(...args),
    saveDraft: (...args: unknown[]) => saveDraft(...args),
    createWorkingDraft: (...args: unknown[]) => createWorkingDraft(...args),
    listSkillFiles: (...args: unknown[]) => listSkillFiles(...args),
    listSkillVersions: (...args: unknown[]) => listSkillVersions(...args),
    listSkillGroups: (...args: unknown[]) => listSkillGroups(...args),
    publishSkill: (...args: unknown[]) => publishSkill(...args),
    rollbackSkill: (...args: unknown[]) => rollbackSkill(...args),
    enableSkill: (...args: unknown[]) => enableSkill(...args),
    disableSkill: (...args: unknown[]) => disableSkill(...args),
    uploadDraftFile: (...args: unknown[]) => uploadDraftFile(...args),
    deleteDraftFile: (...args: unknown[]) => deleteDraftFile(...args),
    downloadSkillFile: (...args: unknown[]) => downloadSkillFile(...args),
    patchSkillMetadata: (...args: unknown[]) => patchSkillMetadata(...args),
  };
});

const skillA: SkillManageListItem = {
  id: 'skill-a',
  canonicalName: 'alpha-skill',
  ownerUserId: 'u1',
  groupId: null,
  visibility: 'private',
  enabled: false,
  publishedVersion: null,
  revision: '1',
  deletedAt: null,
  createdAt: '',
  updatedAt: '',
  canEdit: true,
  canPublish: true,
  canManage: true,
};

const skillB: SkillManageListItem = {
  ...skillA,
  id: 'skill-b',
  canonicalName: 'beta-skill',
  revision: '5',
  canEdit: false,
  canPublish: false,
  canManage: false,
};

function detailFor(item: SkillManageListItem, md: string, caps?: Partial<Pick<SkillManageDetail, 'canEdit' | 'canPublish' | 'canManage'>>): SkillManageDetail {
  return {
    skill: item,
    grants: [],
    audienceIds: [],
    draft: {
      skillId: item.id,
      version: 1,
      state: 'draft',
      description: 'd',
      skillMd: md,
      manifestHash: null,
      runtimeManifest: null,
      createdBy: 'u1',
      publishedBy: null,
      publishedAt: null,
      publishedRemark: null,
      revision: item.revision,
      createdAt: '',
      updatedAt: '',
    },
    published: null,
    canEdit: caps?.canEdit ?? item.canEdit,
    canPublish: caps?.canPublish ?? item.canPublish,
    canManage: caps?.canManage ?? item.canManage,
  };
}

function shellContext(): AgentShellContextValue {
  return {
    user: { id: 'u1', email: 'a@t.test', displayName: 'A', roles: ['user'] },
    onLogout: vi.fn(),
    list: { refresh: vi.fn() } as never,
    threadSource: 'default',
    setThreadSource: vi.fn(),
    visibleThreads: [],
    historySearch: {} as never,
    theme: 'dark',
    setTheme: vi.fn(),
    setChatActions: vi.fn(),
    deleteThread: vi.fn(),
  };
}

function renderPage() {
  const value = shellContext();
  return render(<MemoryRouter initialEntries={['/agent/skills']}>
    <Routes>
      <Route element={<Outlet context={value} />}>
        <Route path="/agent/skills" element={<SkillsPage />} />
      </Route>
    </Routes>
  </MemoryRouter>);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

beforeEach(() => {
  listManageableSkills.mockResolvedValue({ items: [skillA, skillB], total: 2, page: 1, pageSize: 20 });
  listSkillGroups.mockResolvedValue({ items: [{ id: 'g1', name: '工具', sort: 1, createdAt: '', updatedAt: '' }] });
  listSkillFiles.mockResolvedValue({ files: [] });
  listSkillVersions.mockResolvedValue({
    items: [{
      version: 1, state: 'draft', description: 'd', manifestHash: null,
      publishedAt: null, publishedRemark: null, createdAt: '', updatedAt: '',
    }],
  });
  getSkillDetail.mockImplementation(async (id: string) => {
    if (id === 'skill-a') return detailFor(skillA, '# server-a');
    return detailFor(skillB, '# server-b');
  });
  createSkill.mockResolvedValue({
    skill: { ...skillA, id: 'skill-new', canonicalName: 'new-skill', revision: '1' },
    version: detailFor(skillA, '# new').draft,
  });
  saveDraft.mockResolvedValue({
    skill: { ...skillA, revision: '2' },
    version: { ...detailFor(skillA, '# saved').draft!, skillMd: '# saved', revision: '2' },
  });
});

describe('SkillsPage', () => {
  it('lists skills and supports search pagination category create', async () => {
    renderPage();
    const region = await screen.findByRole('region', { name: '技能管理' });
    expect(await within(region).findByText('alpha-skill')).toBeTruthy();
    expect(within(region).getByText('beta-skill')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('搜索技能'), { target: { value: 'alpha' } });
    fireEvent.change(screen.getByLabelText('分类筛选'), { target: { value: 'g1' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(listManageableSkills).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'alpha', groupId: 'g1', page: 1 }),
    ));

    fireEvent.click(screen.getByRole('button', { name: '新建技能' }));
    const dialog = screen.getByRole('dialog', { name: '新建技能' });
    fireEvent.change(within(dialog).getByLabelText('规范名'), { target: { value: 'new-skill' } });
    fireEvent.change(within(dialog).getByLabelText('描述'), { target: { value: 'demo desc' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createSkill).toHaveBeenCalledWith({
      name: 'new-skill', description: 'demo desc',
    }));
  });

  it('loads existing grants into permissions and keeps them after a saved revision changes', async () => {
    const grants = [{ userId: 'editor-user', permission: 'edit' as const }];
    getSkillDetail.mockResolvedValue({ ...detailFor(skillA, '# body'), grants, audienceIds: ['audience-1'] });
    patchSkillMetadata.mockResolvedValue({ skill: { ...skillA, groupId: 'g1', revision: '2' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /alpha-skill/ }));
    fireEvent.click(await screen.findByRole('button', { name: '权限' }));
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: 'g1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }));
    await waitFor(() => expect(patchSkillMetadata).toHaveBeenCalledWith('skill-a', {
      expectedRevision: '1', visibility: 'private', groupId: 'g1', grants,
    }));
    await waitFor(() => expect(screen.getByText('editor-user · edit')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }));
    await waitFor(() => expect(patchSkillMetadata).toHaveBeenLastCalledWith('skill-a', {
      expectedRevision: '2', visibility: 'private', groupId: 'g1', grants,
    }));
  });

  it('keeps unsaved body on 409 and disables save after revoke', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /alpha-skill/ }));
    const editor = await screen.findByLabelText('技能正文');
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('# server-a'));
    fireEvent.change(editor, { target: { value: '# local draft' } });

    saveDraft.mockRejectedValueOnce(new SkillApiError(409, 'REVISION_CONFLICT', '冲突'));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => {
      const alerts = screen.getAllByRole('alert').map(node => node.textContent ?? '');
      expect(alerts.some(text => /冲突|保留/.test(text))).toBe(true);
    });
    expect((screen.getByLabelText('技能正文') as HTMLTextAreaElement).value).toBe('# local draft');

    getSkillDetail.mockResolvedValueOnce(detailFor(skillA, '# server-a', {
      canEdit: false, canPublish: false, canManage: false,
    }));
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('ignores stale detail responses when switching skills quickly', async () => {
    let resolveA: (value: SkillManageDetail) => void = () => undefined;
    const pendingA = new Promise<SkillManageDetail>(resolve => { resolveA = resolve; });
    getSkillDetail.mockImplementation((id: string) => {
      if (id === 'skill-a') return pendingA;
      return Promise.resolve(detailFor(skillB, '# server-b'));
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /alpha-skill/ }));
    fireEvent.click(await screen.findByRole('button', { name: /beta-skill/ }));
    await waitFor(() => expect(screen.getByLabelText('技能正文')).toBeTruthy());
    expect((screen.getByLabelText('技能正文') as HTMLTextAreaElement).value).toBe('# server-b');

    resolveA(detailFor(skillA, '# stale-a'));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((screen.getByLabelText('技能正文') as HTMLTextAreaElement).value).toBe('# server-b');
  });

  it('does not fake-update enabled or publishedVersion when publish fails', async () => {
    const publishedSkill: SkillManageListItem = {
      ...skillA,
      publishedVersion: 1,
      enabled: false,
      revision: '4',
    };
    getSkillDetail.mockResolvedValue({
      skill: publishedSkill,
      draft: {
        ...detailFor(publishedSkill, '# draft-v2').draft!,
        version: 2,
        skillMd: '# draft-v2',
      },
      published: {
        ...detailFor(publishedSkill, '# pub-v1').draft!,
        version: 1,
        state: 'published',
        skillMd: '# pub-v1',
      },
      canEdit: true,
      canPublish: true,
      canManage: true,
    });
    listSkillVersions.mockResolvedValue({
      items: [
        {
          version: 2, state: 'draft', description: 'd2', manifestHash: null,
          publishedAt: null, publishedRemark: null, createdAt: '', updatedAt: '',
        },
        {
          version: 1, state: 'published', description: 'd1', manifestHash: 'h',
          publishedAt: '2026-01-01', publishedRemark: null, createdAt: '', updatedAt: '',
        },
      ],
    });
    publishSkill.mockRejectedValue(new SkillApiError(500, 'INTERNAL', '发布失败'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /alpha-skill/ }));
    fireEvent.click(await screen.findByRole('button', { name: '版本' }));
    expect(await screen.findByText(/发布版 1/)).toBeTruthy();
    expect(screen.getByText(/未启用/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    await waitFor(() => expect(publishSkill).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('发布失败'));
    expect(screen.getByText(/发布版 1/)).toBeTruthy();
    expect(screen.getByText(/未启用/)).toBeTruthy();
    expect(screen.queryByText(/已启用/)).toBeNull();
  });

  it('shows publish enable buttons only from API capability flags', async () => {
    getSkillDetail.mockResolvedValue(detailFor(skillB, '# server-b'));
    listSkillVersions.mockResolvedValue({
      items: [{
        version: 1, state: 'draft', description: 'd', manifestHash: null,
        publishedAt: null, publishedRemark: null, createdAt: '', updatedAt: '',
      }],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /beta-skill/ }));
    expect(await screen.findByRole('button', { name: '保存草稿' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '版本' }));
    await screen.findByRole('region', { name: '技能版本' });
    expect(screen.queryByRole('button', { name: '发布' })).toBeNull();
    expect(screen.queryByRole('button', { name: '启用' })).toBeNull();
  });
});
