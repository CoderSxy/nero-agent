import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillEditor } from './SkillEditor';

afterEach(cleanup);

describe('SkillEditor', () => {
  it('edits body and keeps save separate from publish', () => {
    const onChange = vi.fn();
    const onSave = vi.fn();
    render(<SkillEditor
      skillMd="# hello"
      onChange={onChange}
      canEdit
      dirty
      saving={false}
      conflict={false}
      onSave={onSave}
      onReload={vi.fn()}
      workingVersion={2}
      publishedVersion={1}
    />);
    expect(screen.getByText(/工作版 2/)).toBeTruthy();
    expect(screen.getByText(/当前发布版 1/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '发布' })).toBeNull();
    fireEvent.change(screen.getByLabelText('技能正文'), { target: { value: '# edited' } });
    expect(onChange).toHaveBeenCalledWith('# edited');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(onSave).toHaveBeenCalled();
  });

  it('disables save when canEdit is false after revoke', () => {
    render(<SkillEditor
      skillMd="# x"
      onChange={vi.fn()}
      canEdit={false}
      dirty
      saving={false}
      conflict={false}
      onSave={vi.fn()}
      onReload={vi.fn()}
      workingVersion={1}
      publishedVersion={null}
    />);
    expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('无编辑权限');
  });

  it('keeps conflict alert and reload without clearing local content', () => {
    const onReload = vi.fn();
    render(<SkillEditor
      skillMd="# local unsaved"
      onChange={vi.fn()}
      canEdit
      dirty
      saving={false}
      conflict
      onSave={vi.fn()}
      onReload={onReload}
      workingVersion={1}
      publishedVersion={null}
    />);
    expect((screen.getByLabelText('技能正文') as HTMLTextAreaElement).value).toBe('# local unsaved');
    expect(screen.getByRole('alert').textContent).toContain('保留本地未保存正文');
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(onReload).toHaveBeenCalled();
  });
});
