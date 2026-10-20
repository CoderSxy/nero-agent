import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillEditorPanel } from './SkillEditorPanel';

describe('SkillEditorPanel', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the panel when discard is declined', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onRequestClose = vi.fn();
    render(<SkillEditorPanel dirty onRequestClose={onRequestClose}><p>正文</p></SkillEditorPanel>);
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(window.confirm).toHaveBeenCalledWith('有未保存的修改，是否放弃？');
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(screen.getByText('正文')).toBeTruthy();
  });

  it('closes after discard is confirmed and skips the prompt when clean', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onRequestClose = vi.fn();
    const view = render(<SkillEditorPanel dirty onRequestClose={onRequestClose}><p>正文</p></SkillEditorPanel>);
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(onRequestClose).toHaveBeenCalledOnce();

    onRequestClose.mockClear();
    view.rerender(<SkillEditorPanel dirty={false} onRequestClose={onRequestClose}><p>正文</p></SkillEditorPanel>);
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it('registers beforeunload only while dirty', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = render(<SkillEditorPanel dirty onRequestClose={() => undefined}><p>正文</p></SkillEditorPanel>);
    expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    view.rerender(<SkillEditorPanel dirty={false} onRequestClose={() => undefined}><p>正文</p></SkillEditorPanel>);
    expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });
});
