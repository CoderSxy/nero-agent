import type { AuthUser } from '../auth/service';
import { assertAllowedEndpoint, normalizeModelEndpoint } from './endpoint-policy';
import { insertRecord, listAllPublic, lockPublicDefault, updateRecord, withTransaction, type ModelRecord } from './repository';
import { createGuardedModelFetch } from './transport';
import { ModelCatalogError } from './types';
import type { CatalogMetadata } from './types';

export const GATEWAY_BASE_URL = 'https://api.nerosun.cn/v1';
export function gatewayCatalogUrl(): string {
  return new URL('/api/model-catalog?realm=cn&force=false', GATEWAY_BASE_URL).toString();
}
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:/-]+$/;
const MAX_MODELS = 500;
type GatewayModel = { modelId: string; displayName: string; catalogMetadata: CatalogMetadata | null; imageSupport: boolean | null };
type LocalModel = Pick<ModelRecord, 'modelId' | 'displayName' | 'baseUrl'> & { ref?: string };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function first(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

function boundedNumber(value: unknown, max: number): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= max ? number : undefined;
}

function boundedText(value: unknown, max = 80): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function creditMultiplier(value: unknown): number | undefined {
  if (typeof value === 'string' && /^x\d+(?:\.\d+)?$/i.test(value.trim())) {
    return boundedNumber(value.trim().slice(1), 1_000_000);
  }
  return boundedNumber(value, 1_000_000);
}

function modality(value: unknown): CatalogMetadata['modality'] | undefined {
  if (Array.isArray(value)) {
    const modes = value.filter((part): part is string => typeof part === 'string').map(part => part.toLowerCase());
    if (modes.some(part => ['image', 'vision'].includes(part))) return 'multimodal';
    if (modes.length === 1 && modes[0] === 'text') return 'text';
    return undefined;
  }
  if (typeof value === 'boolean') return value ? 'multimodal' : 'text';
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['multimodal', 'multi-modal', '多模态', 'vision', 'image'].includes(normalized)) return 'multimodal';
  if (['text', 'text-only', '文本', '纯文本'].includes(normalized)) return 'text';
  if (normalized === 'router') return 'router';
  if (['unknown', 'unverified', '待核实', '待验证'].includes(normalized)) return 'unverified';
  return undefined;
}

function parseMetadata(item: Record<string, unknown>): { catalogMetadata: CatalogMetadata | null; imageSupport: boolean | null } {
  const capabilities = object(item.capabilities);
  const limits = object(item.limits);
  const reasoning = object(item.reasoning);
  const metadata: CatalogMetadata = {};
  const contextWindow = boundedNumber(first(item, ['context_window', 'contextWindow', 'context_length', 'contextLength', 'max_context_tokens'])
    ?? first(limits, ['context_window', 'contextWindow', 'context']), 10_000_000);
  if (contextWindow !== undefined) metadata.contextWindow = contextWindow;
  const maxOutputTokens = boundedNumber(first(item, ['max_output_tokens', 'maxOutputTokens', 'output_limit', 'max_tokens'])
    ?? first(limits, ['max_output_tokens', 'maxOutputTokens', 'output']), 10_000_000);
  if (maxOutputTokens !== undefined) metadata.maxOutputTokens = maxOutputTokens;
  const efforts = first(item, ['efforts', 'reasoning_efforts', 'reasoningEfforts', 'supported_reasoning_efforts', 'thinking_levels'])
    ?? first(reasoning, ['efforts', 'levels']);
  if (Array.isArray(efforts)) {
    const list = [...new Set(efforts.map(value => boundedText(value, 24)).filter((value): value is string => !!value))].slice(0, 12);
    if (list.length) metadata.reasoningEfforts = list;
  }
  const defaultReasoningEffort = boundedText(first(item, ['default_effort', 'default_reasoning_effort', 'defaultReasoningEffort', 'default_thinking_level'])
    ?? first(reasoning, ['default_effort', 'defaultEffort', 'default']), 24);
  if (defaultReasoningEffort) metadata.defaultReasoningEffort = defaultReasoningEffort;
  const multiplier = creditMultiplier(first(item, ['credits', 'credit_multiplier', 'creditMultiplier', 'cost_multiplier', 'costMultiplier', 'multiplier']));
  if (multiplier !== undefined) metadata.creditMultiplier = multiplier;
  if (typeof item.credits === 'string' && /^x\d+(?:\.\d+)?$/i.test(item.credits.trim())) {
    metadata.creditLabel = item.credits.trim();
  }
  const catalogModality = modality(first(item, ['native_modality', 'nativeModality', 'modality', 'modalities', 'input_modalities', 'inputModalities', 'input_modality', 'inputModality', 'model_type', 'modelType', 'multimodal', 'is_multimodal', 'isMultimodal'])
    ?? first(capabilities, ['modality', 'multimodal']));
  if (catalogModality) metadata.modality = catalogModality;
  const providerName = boundedText(first(item, ['series', 'provider_name', 'providerName', 'provider_label', 'providerLabel', 'provider', 'brand']));
  if (providerName) metadata.providerName = providerName;
  const description = boundedText(item.description, 500);
  if (description) metadata.description = description;
  const inferenceOnly = boolean(first(item, ['only_reasoning', 'inference_only', 'inferenceOnly', 'is_inference_only', 'isInferenceOnly', 'infer_only', 'reasoning_only'])
    ?? first(capabilities, ['inference_only', 'inferenceOnly']));
  if (inferenceOnly !== undefined) metadata.inferenceOnly = inferenceOnly;
  const imageInputConflict = boolean(first(item, ['image_input_conflict', 'imageInputConflict']));
  if (imageInputConflict !== undefined) metadata.imageInputConflict = imageInputConflict;
  const nativeModalityPresent = Object.hasOwn(item, 'native_modality') || Object.hasOwn(item, 'nativeModality');
  const explicitImage = boolean(first(item, ['supports_images', 'supportsImages', 'supports_image', 'supportsImage', 'support_image', 'supports_vision', 'supportsVision', 'vision'])
    ?? first(capabilities, ['supports_images', 'supportsImages', 'supports_image', 'supportsImage', 'vision', 'image']));
  // The catalog's native modality is the reviewed model capability. The platform image
  // flag alone may be true even for a native text-only model (for example GLM-5.3).
  const imageSupport = nativeModalityPresent
    ? catalogModality === 'multimodal' && explicitImage === true && imageInputConflict !== true
    : null;
  if (nativeModalityPresent) metadata.imageSupport = imageSupport;
  return { catalogMetadata: Object.keys(metadata).length ? metadata : null, imageSupport };
}

function adminOnly(user: AuthUser): void {
  if (!user.roles.includes('admin')) throw new ModelCatalogError('forbidden', '无权同步公共模型');
}

export function parseGatewayModelList(payload: unknown): GatewayModel[] {
  if (!payload || typeof payload !== 'object' || !('models' in payload) || !Array.isArray(payload.models)
    || payload.models.length === 0 || payload.models.length > MAX_MODELS) {
    throw new ModelCatalogError('invalid_input', '国内版模型中心列表格式无效或数量超限');
  }
  const seen = new Set<string>();
  const models: GatewayModel[] = [];
  for (const item of payload.models) {
    const id = item && typeof item === 'object' && 'id' in item ? item.id : undefined;
    if (typeof id !== 'string' || id.length < 1 || id.length > 200 || !MODEL_ID_PATTERN.test(id)
      || id.split('/').includes('..')) {
      throw new ModelCatalogError('invalid_input', '网关返回了不支持的模型 ID');
    }
    if (id.startsWith('global:') || id.startsWith('cn:') || seen.has(id)) continue;
    const modelId = id;
    seen.add(modelId);
    const name = item && typeof item === 'object'
      ? ('name' in item && typeof item.name === 'string' ? item.name : '').trim() : '';
    models.push({ modelId, displayName: name && name.length <= 100 ? name : modelId.slice(0, 100), ...parseMetadata(object(item)) });
  }
  if (models.length === 0) throw new ModelCatalogError('invalid_input', '模型中心没有返回可同步的国内版模型');
  return models;
}

export function compareGatewayModels(remote: GatewayModel[], local: LocalModel[]) {
  const owned = local.filter(item => item.baseUrl === GATEWAY_BASE_URL);
  const byId = new Map(owned.map(item => [item.modelId, item]));
  const remoteIds = new Set(remote.map(item => item.modelId));
  return {
    incoming: remote.map(item => {
      const existing = byId.get(item.modelId);
      return existing
        ? { ...item, displayName: existing.displayName, status: 'existing' as const, ref: existing.ref }
        : { ...item, status: 'new' as const };
    }),
    missing: owned.filter(item => !remoteIds.has(item.modelId))
      .map(item => ({ modelId: item.modelId, displayName: item.displayName, ref: item.ref })),
  };
}

function sourceModel(models: ModelRecord[]): ModelRecord {
  const source = models.find(model => model.baseUrl === GATEWAY_BASE_URL && model.enabled && model.apiKeyCiphertext);
  if (!source) throw new ModelCatalogError('missing_key', '请先为该网关手动配置一个公共模型及 API Key，再同步模型列表');
  return source;
}

function managementToken(input: unknown): string {
  if (!input || typeof input !== 'object' || !('managementToken' in input)
    || typeof input.managementToken !== 'string' || !/^wbt_[A-Za-z0-9_-]{20,100}$/.test(input.managementToken)) {
    throw new ModelCatalogError('invalid_input', '请填写模型中心的只读管理 API Token（wbt_ 开头）');
  }
  return input.managementToken;
}

async function fetchGatewayModels(source: ModelRecord, token: string): Promise<GatewayModel[]> {
  const baseUrl = normalizeModelEndpoint(GATEWAY_BASE_URL);
  await assertAllowedEndpoint(baseUrl);
  const fetch = createGuardedModelFetch(new URL('/api', GATEWAY_BASE_URL));
  let response: Response;
  try {
    response = await fetch(gatewayCatalogUrl(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new ModelCatalogError('invalid_input', '无法连接模型网关，请检查服务与网络');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelCatalogError('invalid_input', response.status === 401 || response.status === 403
      ? '管理 API Token 无效或无权读取模型中心' : `模型中心返回 ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ModelCatalogError('invalid_input', '网关没有返回模型列表');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1024 * 1024) {
      await reader.cancel();
      throw new ModelCatalogError('invalid_input', '网关模型列表过大');
    }
    chunks.push(value);
  }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ModelCatalogError('invalid_input', '网关模型列表不是有效 JSON'); }
  return parseGatewayModelList(payload);
}

export async function previewGatewaySync(user: AuthUser, input: unknown) {
  adminOnly(user);
  const token = managementToken(input);
  const current = await listAllPublic();
  const source = sourceModel(current);
  const remote = await fetchGatewayModels(source, token);
  return { source: source.displayName, ...compareGatewayModels(remote, current) };
}

export async function applyGatewaySync(user: AuthUser, input: unknown): Promise<{ created: number; updated: number }> {
  adminOnly(user);
  if (!input || typeof input !== 'object' || !('items' in input) || !Array.isArray(input.items)
    || input.items.length > MAX_MODELS) throw new ModelCatalogError('invalid_input', '同步选择无效');
  const selected = new Map<string, string>();
  for (const item of input.items) {
    if (!item || typeof item !== 'object' || typeof item.modelId !== 'string' ||
      typeof item.displayName !== 'string' || selected.has(item.modelId)) {
      throw new ModelCatalogError('invalid_input', '同步选择无效或包含重复模型');
    }
    const name = item.displayName.trim();
    if (!name || name.length > 100) throw new ModelCatalogError('invalid_input', '模型显示名称需为 1 到 100 个字符');
    selected.set(item.modelId, name);
  }
  const before = await listAllPublic();
  const remote = await fetchGatewayModels(sourceModel(before), managementToken(input));
  const remoteById = new Map(remote.map(item => [item.modelId, item]));
  const remoteIds = new Set(remoteById.keys());
  if ([...selected.keys()].some(id => !remoteIds.has(id))) {
    throw new ModelCatalogError('invalid_input', '网关模型列表已变化，请重新预览');
  }
  return withTransaction(async db => {
    await lockPublicDefault(db);
    const current = await listAllPublic(db);
    const source = sourceModel(current);
    const existing = current.filter(item => item.baseUrl === GATEWAY_BASE_URL);
    const existingIds = new Set(existing.map(item => item.modelId));
    if ([...selected.keys()].some(id => existingIds.has(id))) {
      throw new ModelCatalogError('invalid_input', '公共模型列表已变化，请重新预览');
    }
    let updated = 0;
    for (const model of existing) {
      const catalog = remoteById.get(model.modelId);
      if (!catalog) continue;
      const changes: Partial<ModelRecord> = {};
      if (catalog.catalogMetadata !== null) changes.catalogMetadata = catalog.catalogMetadata;
      if (catalog.imageSupport !== null) changes.supportsVision = catalog.imageSupport;
      if (changes.catalogMetadata !== undefined || changes.supportsVision !== undefined) {
        await updateRecord('public', model.id, null, changes, db);
        updated += 1;
      }
    }
    let hasDefault = current.some(item => item.isDefault && item.enabled);
    for (const [modelId, displayName] of selected) {
      const catalog = remoteById.get(modelId)!;
      await insertRecord('public', null, {
        displayName, providerId: 'workbuddy', modelId, baseUrl: GATEWAY_BASE_URL,
        apiMode: 'chat', apiKeyCiphertext: source.apiKeyCiphertext,
        enabled: true, supportsVision: catalog.imageSupport === true,
        catalogMetadata: catalog.catalogMetadata, isDefault: !hasDefault,
      }, db);
      hasDefault = true;
    }
    return { created: selected.size, updated };
  });
}
