import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillPermissions } from './SkillPermissions';

afterEach(cleanup);

describe('SkillPermissions', () => {
  it('saves visibility grants when canManage', () => {
    const onSave = vi.fn();
    render(<SkillPermissions
      grants={[]}
      visibility="private"
      groupId={null}
      groups={[{ id: 'g1', name: '工具', sort: 1, createdAt: '', updatedAt: '' }]}
      canManage
      busy={false}
      onSave={onSave}
    />);
    fireEvent.change(screen.getByLabelText('可见性'), { target: { value: 'restricted' } });
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: 'g1' } });
    fireEvent.change(screen.getByLabelText('授权用户 ID'), {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.change(screen.getByLabelText('授权权限'), { target: { value: 'edit' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }));
    expect(onSave).toHaveBeenCalledWith({
      visibility: 'restricted',
      groupId: 'g1',
      grants: [{ userId: '11111111-1111-4111-8111-111111111111', permission: 'edit' }],
    });
  });

  it('preserves server grants on category saves and supports explicit removal and addition', () => {
    const onSave = vi.fn();
    const grants = [
      { userId: 'existing', permission: 'use' as const },
      { userId: 'existing', permission: 'edit' as const },
      { userId: 'publisher', permission: 'publish' as const },
    ];
    render(<SkillPermissions visibility="restricted" groupId={null} groups={[
      { id: 'g1', name: '工具', sort: 1, createdAt: '', updatedAt: '' },
    ]} grants={grants} canManage busy={false} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: 'g1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }));
    expect(onSave).toHaveBeenLastCalledWith({ visibility: 'restricted', groupId: 'g1', grants });
    fireEvent.click(screen.getAllByRole('button', { name: '移除' })[1]!);
    fireEvent.change(screen.getByLabelText('授权用户 ID'), { target: { value: 'new-user' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }));
    expect(onSave).toHaveBeenLastCalledWith({ visibility: 'restricted', groupId: 'g1', grants: [
      grants[0], grants[2], { userId: 'new-user', permission: 'use' },
    ] });
  });

  it('blocks edits without canManage', () => {
    render(<SkillPermissions
      grants={[]}
      visibility="private"
      groupId={null}
      groups={[]}
      canManage={false}
      busy={false}
      onSave={vi.fn()}
    />);
    expect(screen.queryByRole('button', { name: '保存权限' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('owner/admin');
  });
});
