import type { AuthUser } from '../auth/service';
import { assertAllowedEndpoint, normalizeModelEndpoint } from './endpoint-policy';
import { insertRecord, listAllPublic, lockPublicDefault, withTransaction, type ModelRecord } from './repository';
import { createGuardedModelFetch } from './transport';
import { ModelCatalogError } from './types';

export const GATEWAY_BASE_URL = 'https://api.nerosun.cn/v1';
export function gatewayCatalogUrl(): string {
  return new URL('/api/model-catalog?realm=cn&force=false', GATEWAY_BASE_URL).toString();
}
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:/-]+$/;
const MAX_MODELS = 500;
type GatewayModel = { modelId: string; displayName: string };
type LocalModel = Pick<ModelRecord, 'modelId' | 'displayName' | 'baseUrl'> & { ref?: string };

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
    models.push({ modelId, displayName: name && name.length <= 100 ? name : modelId.slice(0, 100) });
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
        ? { modelId: item.modelId, displayName: existing.displayName, status: 'existing' as const, ref: existing.ref }
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

export async function applyGatewaySync(user: AuthUser, input: unknown): Promise<{ created: number }> {
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
  if (selected.size === 0) return { created: 0 };
  const before = await listAllPublic();
  const remote = await fetchGatewayModels(sourceModel(before), managementToken(input));
  const remoteIds = new Set(remote.map(item => item.modelId));
  if ([...selected.keys()].some(id => !remoteIds.has(id))) {
    throw new ModelCatalogError('invalid_input', '网关模型列表已变化，请重新预览');
  }
  return withTransaction(async db => {
    await lockPublicDefault(db);
    const current = await listAllPublic(db);
    const source = sourceModel(current);
    const existing = new Set(current.filter(item => item.baseUrl === GATEWAY_BASE_URL).map(item => item.modelId));
    if ([...selected.keys()].some(id => existing.has(id))) {
      throw new ModelCatalogError('invalid_input', '公共模型列表已变化，请重新预览');
    }
    let hasDefault = current.some(item => item.isDefault && item.enabled);
    for (const [modelId, displayName] of selected) {
      await insertRecord('public', null, {
        displayName, providerId: 'workbuddy', modelId, baseUrl: GATEWAY_BASE_URL,
        apiMode: 'chat', apiKeyCiphertext: source.apiKeyCiphertext,
        enabled: true, supportsVision: false, isDefault: !hasDefault,
      }, db);
      hasDefault = true;
    }
    return { created: selected.size };
  });
}
