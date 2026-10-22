import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillCard } from './SkillCard';
import type { SkillManageListItem } from './types';

const item: SkillManageListItem = {
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
  description: '',
  canEdit: true,
  canPublish: true,
  canManage: false,
};

describe('SkillCard', () => {
  afterEach(() => cleanup());
  it('shows a fallback description and draft status without a loaded badge', () => {
    render(<SkillCard
      item={item}
      groupLabel="未分组"
      expanded={false}
      preview={null}
      previewLoading={false}
      previewError={null}
      busy={false}
      onToggle={() => undefined}
      onEdit={() => undefined}
      onPublish={() => undefined}
    />);
    expect(screen.getByText('暂无描述')).toBeTruthy();
    expect(screen.getByText(/草稿/)).toBeTruthy();
    expect(screen.queryByText(/已加载/)).toBeNull();
    expect(screen.queryByRole('button', { name: '启用' })).toBeNull();
  });

  it('does not expand when an action button is clicked', () => {
    const onToggle = vi.fn();
    const onEdit = vi.fn();
    render(<SkillCard
      item={{ ...item, description: '天气说明', publishedVersion: 2, enabled: false }}
      groupLabel="工具"
      expanded={false}
      preview={null}
      previewLoading={false}
      previewError={null}
      busy={false}
      onToggle={onToggle}
      onEdit={onEdit}
    />);
    fireEvent.click(screen.getByRole('button', { name: '编辑 alpha-skill' }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByText(/停用 · 已发布 v2/)).toBeTruthy();
  });

  it('shows storage and runtime separately and keeps management when resources are missing', () => {
    render(<SkillCard
      item={{ ...item, description: '天气说明', publishedVersion: 1, enabled: true, storageHealth: 'unavailable', availability: 'ready' }}
      groupLabel="工具"
      expanded={false}
      preview={null}
      previewLoading={false}
      previewError={null}
      busy={false}
      onToggle={() => undefined}
      onEdit={() => undefined}
    />);
    expect(screen.getByText(/资源缺失，暂不可执行/)).toBeTruthy();
    expect(screen.getByText(/运行状态 ready/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑 alpha-skill' })).toBeTruthy();
  });
});
