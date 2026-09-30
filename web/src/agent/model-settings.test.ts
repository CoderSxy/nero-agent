import { describe, expect, it } from 'vitest';
import { createMemoryRequestContext, getDefaultModels, readThreadModels, saveThreadModels, withThreadModels } from './model-settings';
import { vi } from 'vitest';

const providers = [
  { id: 'openai', name: 'OpenAI', connected: false, models: ['gpt-5.6-terra'], envVar: 'OPENAI_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', connected: true, models: ['deepseek-v4-flash'], envVar: 'DEEPSEEK_API_KEY' },
];

describe('per-thread model settings', () => {
  it('chooses a connected chat model when the Agent default has no key', () => {
    expect(getDefaultModels('openai/gpt-5.6-terra', 'deepseek/deepseek-v4-flash', providers))
      .toEqual({ chatModel: 'deepseek/deepseek-v4-flash', memoryModel: 'deepseek/deepseek-v4-flash' });
  });
  it('uses a connected model for memory when its configured provider has no key', () => {
    expect(getDefaultModels('openai/gpt-5.6-terra', 'openai/gpt-5.6-terra', providers))
      .toEqual({ chatModel: 'deepseek/deepseek-v4-flash', memoryModel: 'deepseek/deepseek-v4-flash' });
  });
  it('preserves unrelated thread metadata and reads its saved choices', () => {
    const metadata = withThreadModels({ other: { value: 1 } },
      { chatModel: 'deepseek/deepseek-v4-flash', memoryModel: 'deepseek/deepseek-v4-pro' });
    expect(metadata.other).toEqual({ value: 1 });
    expect(readThreadModels(metadata)).toEqual({
      chatModel: 'deepseek/deepseek-v4-flash', memoryModel: 'deepseek/deepseek-v4-pro',
    });
  });
  it('sends the chosen memory model in Mastra request context', () => {
    expect(createMemoryRequestContext('deepseek/deepseek-v4-pro').get('nero-agent.memory-model'))
      .toBe('deepseek/deepseek-v4-pro');
  });
  it('saves model choices on the same thread without losing other metadata', async () => {
    const get = vi.fn().mockResolvedValue({ resourceId: 'agent', metadata: { other: 'keep' } });
    const update = vi.fn().mockResolvedValue({});
    const models = { chatModel: 'deepseek/deepseek-v4-flash', memoryModel: 'deepseek/deepseek-v4-pro' };
    await saveThreadModels({ get, update }, models);
    expect(update).toHaveBeenCalledWith({ metadata: { other: 'keep', neroAgentModels: models } });
  });
});
