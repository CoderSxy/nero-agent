import { RequestContext } from '@mastra/core/request-context';
import type { ModelRef, SafeModel } from './model-catalog-client';

export interface ModelSettings {
  chatModel: ModelRef;
  memoryModel: ModelRef;
}

const metadataKey = 'neroAgentModels';
export const chatModelRefContextKey = 'nero-agent.chat-model-ref';
export const memoryModelRefContextKey = 'nero-agent.memory-model-ref';

const refPattern = /^(public|private):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const legacyPattern = /^[^/\s:]+\/\S+$/;

export function isModelRef(value: unknown): value is ModelRef {
  return typeof value === 'string' && refPattern.test(value);
}

export function getDefaultModels(catalog: SafeModel[]): ModelSettings | null {
  const enabled = catalog.filter(model => model.enabled !== false);
  const publicModels = enabled.filter(model => model.scope === 'public');
  const choice = publicModels.find(model => model.isDefault) ?? publicModels[0]
    ?? enabled.find(model => model.scope === 'private');
  return choice ? { chatModel: choice.ref, memoryModel: choice.ref } : null;
}

function resolveSaved(value: unknown, catalog: SafeModel[]): ModelRef | null {
  if (isModelRef(value)) return catalog.some(model => model.ref === value) ? value : null;
  if (typeof value !== 'string' || !legacyPattern.test(value)) return null;
  const matches = catalog.filter(model => model.scope === 'public'
    && `${model.providerId}/${model.modelId}` === value);
  return matches.length === 1 ? matches[0].ref : null;
}

export function readThreadModels(metadata: unknown, catalog: SafeModel[]):
  { settings: Partial<ModelSettings>; invalid: boolean } {
  if (!metadata || typeof metadata !== 'object') return { settings: {}, invalid: false };
  const saved = (metadata as Record<string, unknown>)[metadataKey];
  if (saved === undefined || saved === null) return { settings: {}, invalid: false };
  if (typeof saved !== 'object') return { settings: {}, invalid: true };
  const record = saved as Record<string, unknown>;
  const settings: Partial<ModelSettings> = {};
  let invalid = false;
  for (const field of ['chatModel', 'memoryModel'] as const) {
    if (record[field] === undefined) continue;
    const ref = resolveSaved(record[field], catalog);
    if (ref) settings[field] = ref; else invalid = true;
  }
  return { settings, invalid };
}

export function withThreadModels(metadata: unknown, settings: ModelSettings): Record<string, unknown> {
  const current = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : {};
  return { ...current, [metadataKey]: settings };
}

export async function saveThreadModels(thread: {
  get: () => Promise<{ resourceId: string; metadata?: unknown }>;
  update: (params: { metadata: Record<string, unknown> }) => Promise<unknown>;
}, settings: ModelSettings, resourceId: string): Promise<void> {
  if (!isModelRef(settings.chatModel) || !isModelRef(settings.memoryModel)) throw new Error('模型引用无效，请从列表中重新选择');
  const current = await thread.get();
  if (current.resourceId !== resourceId) throw new Error('会话不存在或无权访问');
  await thread.update({ metadata: withThreadModels(current.metadata, settings) });
}

export function createModelRequestContext(settings: ModelSettings): RequestContext {
  const context = new RequestContext();
  context.set(chatModelRefContextKey, settings.chatModel);
  context.set(memoryModelRefContextKey, settings.memoryModel);
  return context;
}
