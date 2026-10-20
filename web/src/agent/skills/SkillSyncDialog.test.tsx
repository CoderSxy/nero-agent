import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillSyncDialog } from './SkillSyncDialog';
import type { SkillVersionSummary } from './types';

const previewSkillSync = vi.fn();
const commitSkillSync = vi.fn();
const exportSkillZip = vi.fn();

vi.mock('./skills-api', () => ({
  previewSkillSync: (...args: unknown[]) => previewSkillSync(...args),
  commitSkillSync: (...args: unknown[]) => commitSkillSync(...args),
  exportSkillZip: (...args: unknown[]) => exportSkillZip(...args),
}));

const versions: SkillVersionSummary[] = [
  { version: 2, state: 'draft', description: 'd', manifestHash: null, publishedAt: null, publishedRemark: null, createdAt: '', updatedAt: '' },
  { version: 1, state: 'published', description: 'p', manifestHash: null, publishedAt: '', publishedRemark: null, createdAt: '', updatedAt: '' },
];

afterEach(() => {
  cleanup();
  previewSkillSync.mockReset();
  commitSkillSync.mockReset();
  exportSkillZip.mockReset();
});

describe('SkillSyncDialog', () => {
  it('leaves deletes unchecked and commits only selected paths', async () => {
    previewSkillSync.mockResolvedValue({
      syncId: '22222222-2222-4222-8222-222222222222',
      diff: {
        syncId: '22222222-2222-4222-8222-222222222222',
        skillId: 'skill-1',
        baseRevision: '4',
        draftVersion: 2,
        expiresAt: '2026-10-19T00:30:00.000Z',
        entries: [
          { path: 'SKILL.md', kind: 'modify', baseHash: 'a', incomingHash: 'b', selected: true },
          { path: 'references/old.txt', kind: 'delete', baseHash: 'c', incomingHash: null, selected: false },
        ],
      },
    });
    commitSkillSync.mockResolvedValue({ skill: { id: 'skill-1' }, version: { version: 2 } });
    render(<SkillSyncDialog
      open
      skillId="skill-1"
      expectedRevision="4"
      canEdit
      canMaintain
      enabledVersion={1}
      versions={versions}
      onClose={vi.fn()}
    />);
    expect(screen.getByLabelText('拉取版本')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('同步 ZIP'), {
      target: { files: [new File(['zip'], 'pack.zip', { type: 'application/zip' })] },
    });
    const remove = await screen.findByLabelText('选择 references/old.txt') as HTMLInputElement;
    expect(remove.checked).toBe(false);
    const skill = screen.getByLabelText('选择 SKILL.md') as HTMLInputElement;
    expect(skill.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '提交选中文件到草稿' }));
    await waitFor(() => expect(commitSkillSync).toHaveBeenCalledWith(
      'skill-1',
      '22222222-2222-4222-8222-222222222222',
      { expectedRevision: '4', selectedPaths: ['SKILL.md'], includeDeletes: false },
    ));
  });

  it('lets use-only export the enabled version and hides version picking', () => {
    render(<SkillSyncDialog
      open
      skillId="skill-1"
      expectedRevision="4"
      canEdit={false}
      canMaintain={false}
      enabledVersion={1}
      versions={versions}
      onClose={vi.fn()}
    />);
    expect(screen.queryByLabelText('拉取版本')).toBeNull();
    expect(screen.getByText(/仅可导出当前启用版本 1/)).toBeTruthy();
    expect(screen.getByText(/不能提交同步/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '拉取 ZIP' }));
    expect(exportSkillZip).toHaveBeenCalledWith('skill-1', 1);
  });
});
