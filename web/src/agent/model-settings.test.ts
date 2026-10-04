import { describe, expect, it, vi } from 'vitest';
import {
  chatModelRefContextKey, createModelRequestContext, getDefaultModels, memoryModelRefContextKey,
  readThreadModels, saveThreadModels, withThreadModels,
} from './model-settings';
import type { SafeModel } from './model-catalog-client';

const ids = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: '33333333-3333-4333-8333-333333333333',
  d: '44444444-4444-4444-8444-444444444444',
  e: '55555555-5555-4555-8555-555555555555',
};

function model(scope: 'public' | 'private', id: string, extra: Partial<SafeModel> = {}): SafeModel {
  return { ref: `${scope}:${id}`, scope, displayName: id, providerId: 'deepseek', modelId: `m-${id.slice(0, 4)}`,
    baseUrl: 'https://api.example.com/v1', apiMode: 'chat', enabled: true, hasApiKey: true, keyHint: '1234', ...extra };
}

const privateFirst = model('private', ids.a);
const publicPlain = model('public', ids.b);
const publicDefault = model('public', ids.c, { isDefault: true });
const catalog = [privateFirst, publicPlain, publicDefault];

describe('catalog-based model settings', () => {
  it('picks the default public model before any other entry', () => {
    expect(getDefaultModels(catalog)).toEqual({ chatModel: publicDefault.ref, memoryModel: publicDefault.ref });
  });
  it('falls back to the first public model, then the first private model, then null', () => {
    expect(getDefaultModels([privateFirst, publicPlain])).toEqual({
      chatModel: publicPlain.ref, memoryModel: publicPlain.ref });
    expect(getDefaultModels([privateFirst])).toEqual({ chatModel: privateFirst.ref, memoryModel: privateFirst.ref });
    expect(getDefaultModels([])).toBeNull();
  });
  it('preserves unrelated thread metadata and reads saved refs', () => {
    const metadata = withThreadModels({ other: { value: 1 } },
      { chatModel: publicPlain.ref, memoryModel: privateFirst.ref });
    expect(metadata.other).toEqual({ value: 1 });
    expect(readThreadModels(metadata, catalog)).toEqual({
      settings: { chatModel: publicPlain.ref, memoryModel: privateFirst.ref }, invalid: false });
  });
  it('treats missing metadata as empty and valid', () => {
    expect(readThreadModels(null, catalog)).toEqual({ settings: {}, invalid: false });
    expect(readThreadModels({ other: 1 }, catalog)).toEqual({ settings: {}, invalid: false });
  });
  it('maps a unique legacy provider/model string to its public ref', () => {
    const legacy = `${publicPlain.providerId}/${publicPlain.modelId}`;
    const unique = [publicPlain, privateFirst];
    expect(readThreadModels({ neroAgentModels: { chatModel: legacy, memoryModel: legacy } }, unique)).toEqual({
      settings: { chatModel: publicPlain.ref, memoryModel: publicPlain.ref }, invalid: false });
  });
  it('flags ambiguous, missing and private-only legacy matches as invalid', () => {
    const twin = model('public', ids.d, { modelId: publicPlain.modelId });
    const legacy = `${publicPlain.providerId}/${publicPlain.modelId}`;
    const ambiguous = readThreadModels({ neroAgentModels: { chatModel: legacy, memoryModel: publicDefault.ref } },
      [publicPlain, twin, publicDefault]);
    expect(ambiguous).toEqual({ settings: { memoryModel: publicDefault.ref }, invalid: true });
    expect(readThreadModels({ neroAgentModels: { chatModel: 'nobody/none', memoryModel: publicDefault.ref } }, catalog)
      .invalid).toBe(true);
    const privateTwin = model('private', ids.e, { providerId: 'solo', modelId: 'only-private' });
    expect(readThreadModels({ neroAgentModels: { chatModel: 'solo/only-private', memoryModel: publicDefault.ref } },
      [privateTwin, publicDefault]).invalid).toBe(true);
  });
  it('flags a foreign private ref or a ref no longer in the catalog as invalid', () => {
    const foreign = `private:${ids.e}`;
    expect(readThreadModels({ neroAgentModels: { chatModel: foreign, memoryModel: publicPlain.ref } }, catalog))
      .toEqual({ settings: { memoryModel: publicPlain.ref }, invalid: true });
    expect(readThreadModels({ neroAgentModels: { chatModel: `public:${ids.e}`, memoryModel: publicPlain.ref } }, catalog)
      .invalid).toBe(true);
  });
  it('puts both selected refs into the request context', () => {
    const context = createModelRequestContext({ chatModel: publicPlain.ref, memoryModel: privateFirst.ref });
    expect(context.get(chatModelRefContextKey)).toBe(publicPlain.ref);
    expect(context.get(memoryModelRefContextKey)).toBe(privateFirst.ref);
    expect(chatModelRefContextKey).toBe('nero-agent.chat-model-ref');
    expect(memoryModelRefContextKey).toBe('nero-agent.memory-model-ref');
  });
  it('saves refs on the same thread without losing other metadata', async () => {
    const get = vi.fn().mockResolvedValue({ resourceId: 'user-1', metadata: { other: 'keep' } });
    const update = vi.fn().mockResolvedValue({});
    const models = { chatModel: publicPlain.ref, memoryModel: privateFirst.ref };
    await saveThreadModels({ get, update }, models, 'user-1');
    expect(update).toHaveBeenCalledWith({ metadata: { other: 'keep', neroAgentModels: models } });
  });
  it('refuses to save onto a thread owned by someone else', async () => {
    const get = vi.fn().mockResolvedValue({ resourceId: 'other', metadata: {} });
    const update = vi.fn();
    await expect(saveThreadModels({ get, update },
      { chatModel: publicPlain.ref, memoryModel: publicPlain.ref }, 'user-1')).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});
