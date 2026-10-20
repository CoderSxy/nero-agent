import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillVersions } from './SkillVersions';

afterEach(cleanup);

const versions = [
  {
    version: 2, state: 'draft' as const, description: 'work', manifestHash: null,
    publishedAt: null, publishedRemark: null, createdAt: '', updatedAt: '',
  },
  {
    version: 1, state: 'published' as const, description: 'live', manifestHash: 'abc',
    publishedAt: '2026-01-01', publishedRemark: null, createdAt: '', updatedAt: '',
  },
];

describe('SkillVersions', () => {
  it('distinguishes working and published versions and wires publish rollback enable', () => {
    const onPublish = vi.fn();
    const onRollback = vi.fn();
    const onEnable = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SkillVersions
      versions={versions}
      publishedVersion={1}
      draftVersion={2}
      enabled={false}
      canEdit
      canPublish
      canManage
      busy={false}
      onCreateDraft={vi.fn()}
      onPublish={onPublish}
      onRollback={onRollback}
      onEnable={onEnable}
      onDisable={vi.fn()}
    />);
    expect(screen.getByText(/工作版 2/)).toBeTruthy();
    expect(screen.getByText(/发布版 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    expect(onPublish).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: '启用' }));
    expect(onEnable).toHaveBeenCalled();
  });

  it('hides publish enable when caps deny them', () => {
    render(<SkillVersions
      versions={versions}
      publishedVersion={1}
      draftVersion={2}
      enabled={false}
      canEdit
      canPublish={false}
      canManage={false}
      busy={false}
      onCreateDraft={vi.fn()}
      onPublish={vi.fn()}
      onRollback={vi.fn()}
      onEnable={vi.fn()}
      onDisable={vi.fn()}
    />);
    expect(screen.queryByRole('button', { name: '发布' })).toBeNull();
    expect(screen.queryByRole('button', { name: '启用' })).toBeNull();
    expect(screen.queryByRole('button', { name: '禁用' })).toBeNull();
  });

  it('offers create draft when published exists and no working draft', () => {
    const onCreateDraft = vi.fn();
    render(<SkillVersions
      versions={[versions[1]!]}
      publishedVersion={1}
      draftVersion={null}
      enabled
      canEdit
      canPublish
      canManage
      busy={false}
      onCreateDraft={onCreateDraft}
      onPublish={vi.fn()}
      onRollback={vi.fn()}
      onEnable={vi.fn()}
      onDisable={vi.fn()}
    />);
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }));
    expect(onCreateDraft).toHaveBeenCalled();
  });
});
