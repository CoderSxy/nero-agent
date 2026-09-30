import { RequestContext } from '@mastra/core/request-context';

export interface ModelSettings {
  chatModel: string;
  memoryModel: string;
}

export interface ModelProvider {
  id: string;
  name: string;
  connected: boolean;
  models: string[];
  envVar: string | string[];
}

const metadataKey = 'neroAgentModels';
export const memoryModelContextKey = 'nero-agent.memory-model';

export function providerModelIds(providers: ModelProvider[]): string[] {
  return providers.filter(provider => provider.connected).flatMap(provider =>
    provider.models.map(model => model.includes('/') ? model : `${provider.id}/${model}`));
}

export function getDefaultModels(agentModel: string, memoryModel: string | undefined,
  providers: ModelProvider[]): ModelSettings {
  const available = providerModelIds(providers);
  const chatModel = available.includes(agentModel) ? agentModel
    : memoryModel && available.includes(memoryModel) ? memoryModel
      : available[0] || agentModel;
  return { chatModel, memoryModel: memoryModel && available.includes(memoryModel) ? memoryModel : chatModel };
}

function validModel(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][\w-]*\/[a-z\d][\w.\-]*$/i.test(value);
}

export function readThreadModels(metadata: unknown): Partial<ModelSettings> {
  if (!metadata || typeof metadata !== 'object') return {};
  const saved = (metadata as Record<string, unknown>)[metadataKey];
  if (!saved || typeof saved !== 'object') return {};
  const record = saved as Record<string, unknown>;
  return {
    ...(validModel(record.chatModel) ? { chatModel: record.chatModel } : {}),
    ...(validModel(record.memoryModel) ? { memoryModel: record.memoryModel } : {}),
  };
}

export function withThreadModels(metadata: unknown, settings: ModelSettings): Record<string, unknown> {
  const current = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : {};
  return { ...current, [metadataKey]: settings };
}

export async function saveThreadModels(thread: {
  get: () => Promise<{ resourceId: string; metadata?: unknown }>;
  update: (params: { metadata: Record<string, unknown> }) => Promise<unknown>;
}, settings: ModelSettings): Promise<void> {
  const current = await thread.get();
  if (current.resourceId !== 'agent') throw new Error('会话不存在或无权访问');
  await thread.update({ metadata: withThreadModels(current.metadata, settings) });
}

export function createMemoryRequestContext(memoryModel: string): RequestContext {
  const context = new RequestContext();
  context.set(memoryModelContextKey, memoryModel);
  return context;
}
