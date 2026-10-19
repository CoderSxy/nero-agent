import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MobileThreadActions } from './MobileThreadActions';

afterEach(cleanup);

it('renames the open conversation from its mobile action sheet', async () => {
  const rename = vi.fn().mockResolvedValue(undefined);
  render(<MobileThreadActions title="旧名称" open onClose={vi.fn()} onRename={rename} onDelete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '修改会话名' }));
  fireEvent.change(screen.getByRole('textbox', { name: '会话名称' }), { target: { value: '新名称' } });
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
  await waitFor(() => expect(rename).toHaveBeenCalledWith('新名称'));
});

it('requires a second action to delete a conversation', async () => {
  const remove = vi.fn().mockResolvedValue(undefined);
  render(<MobileThreadActions title="要删除的会话" open onClose={vi.fn()} onRename={vi.fn()} onDelete={remove} />);
  fireEvent.click(screen.getByRole('button', { name: '删除会话' }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
});
