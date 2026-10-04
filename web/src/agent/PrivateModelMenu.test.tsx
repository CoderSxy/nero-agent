import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateModelMenu } from './PrivateModelMenu';
import type { SafeModel } from './model-catalog-client';

const list = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
vi.mock('./model-catalog-client', () => ({
  listPrivateModels: () => list(),
  createPrivateModel: (input: unknown) => create(input),
  updatePrivateModel: (ref: string, patch: unknown) => update(ref, patch),
  deletePrivateModel: (ref: string) => remove(ref),
}));

const ref = 'private:22222222-2222-4222-8222-222222222222';
const existing: SafeModel = { ref, scope: 'private', displayName: 'Pro', providerId: 'deepseek', modelId: 'v4-pro',
  baseUrl: 'https://api.example.com/v1', apiMode: 'chat', enabled: true, hasApiKey: true, keyHint: '5678' };

beforeEach(() => { list.mockResolvedValue([existing]); });
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); });

function setup() {
  const onChanged = vi.fn().mockResolvedValue(undefined);
  render(<PrivateModelMenu onBack={vi.fn()} onChanged={onChanged} />);
  return { onChanged };
}
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('private model management', () => {
  it('lists safe fields only and never renders the key', async () => {
    setup();
    expect(await screen.findByText('Pro')).toBeTruthy();
    expect(screen.getByText(/5678/)).toBeTruthy();
    expect(screen.getByText('设置 → API Key 管理')).toBeTruthy();
  });

  it('creates a private model, sends the key once and clears it from the form', async () => {
    create.mockResolvedValue({ ...existing, ref: 'private:33333333-3333-4333-8333-333333333333', displayName: 'New' });
    const { onChanged } = setup();
    await screen.findByText('Pro');
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    type('显示名称', 'New'); type('Provider ID', 'deepseek'); type('Model ID', 'v4-new');
    type('Base URL', 'https://api.example.com/v1'); type('API Key', 'sk-secret-9999');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ displayName: 'New', providerId: 'deepseek',
      modelId: 'v4-new', baseUrl: 'https://api.example.com/v1', apiMode: 'chat', enabled: true,
      apiKey: 'sk-secret-9999' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByDisplayValue('sk-secret-9999')).toBeNull();
    expect(JSON.stringify({ ...localStorage })).not.toContain('sk-secret');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('sk-secret');
  });

  it('omits apiKey from PATCH when the key field is blank', async () => {
    update.mockResolvedValue({ ...existing, displayName: 'Renamed' });
    const { onChanged } = setup();
    await screen.findByText('Pro');
    fireEvent.click(screen.getByRole('button', { name: '编辑 Pro' }));
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
    type('显示名称', 'Renamed');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const [calledRef, patch] = update.mock.calls[0];
    expect(calledRef).toBe(ref);
    expect(patch.displayName).toBe('Renamed');
    expect('apiKey' in patch).toBe(false);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('includes apiKey in PATCH when the key is replaced', async () => {
    update.mockResolvedValue(existing);
    setup();
    await screen.findByText('Pro');
    fireEvent.click(screen.getByRole('button', { name: '编辑 Pro' }));
    type('API Key', 'sk-new-0000');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].apiKey).toBe('sk-new-0000');
  });

  it('disables a model and notifies the parent', async () => {
    update.mockResolvedValue({ ...existing, enabled: false });
    const { onChanged } = setup();
    await screen.findByText('Pro');
    fireEvent.click(screen.getByRole('button', { name: '停用 Pro' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(ref, { enabled: false }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText('已停用')).toBeTruthy();
  });

  it('requires explicit confirmation before deleting', async () => {
    remove.mockResolvedValue(undefined);
    const { onChanged } = setup();
    await screen.findByText('Pro');
    fireEvent.click(screen.getByRole('button', { name: '删除 Pro' }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消删除' }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '删除 Pro' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(ref));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Pro')).toBeNull());
  });

  it('shows API errors and disables submit while saving', async () => {
    let reject: (error: Error) => void = () => undefined;
    create.mockReturnValue(new Promise((_, r) => { reject = r; }));
    setup();
    await screen.findByText('Pro');
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    type('显示名称', 'X'); type('Provider ID', 'p'); type('Model ID', 'm');
    type('Base URL', 'https://api.example.com/v1'); type('API Key', 'sk-1');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '保存中…' }) as HTMLButtonElement).disabled).toBe(true));
    reject(new Error('Base URL 不在允许列表'));
    expect((await screen.findByRole('alert')).textContent).toContain('Base URL 不在允许列表');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
