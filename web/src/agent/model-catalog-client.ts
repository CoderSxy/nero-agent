import { apiFetch } from './client';

export type ModelScope = 'public' | 'private';
export type ModelRef = `public:${string}` | `private:${string}`;
export type ApiMode = 'chat' | 'responses';

export interface SafeModel {
  ref: ModelRef;
  scope: ModelScope;
  displayName: string;
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiMode: ApiMode;
  enabled: boolean;
  hasApiKey: boolean;
  keyHint: string | null;
  isDefault?: boolean;
}

export interface PrivateModelInput {
  displayName: string;
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiMode: ApiMode;
  enabled: boolean;
  apiKey: string;
}

export type PrivateModelPatch = Partial<PrivateModelInput>;

async function privateRequest(path: string, init: RequestInit, fallback: string): Promise<unknown> {
  const response = await apiFetch(path, init);
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new Error(typeof body.error === 'string' && body.error ? body.error : fallback);
  return body;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function modelFrom(body: unknown): SafeModel {
  const model = (body as { model?: SafeModel }).model;
  if (!model) throw new Error('模型响应格式错误');
  return model;
}

export async function listPrivateModels(): Promise<SafeModel[]> {
  const body = await privateRequest('/model-catalog/private', {}, '加载我的模型失败') as { models?: unknown };
  if (!Array.isArray(body.models)) throw new Error('模型列表格式错误');
  return body.models as SafeModel[];
}

export async function createPrivateModel(input: PrivateModelInput): Promise<SafeModel> {
  return modelFrom(await privateRequest('/model-catalog/private', jsonInit('POST', input), '添加模型失败'));
}

export async function updatePrivateModel(ref: ModelRef, patch: PrivateModelPatch): Promise<SafeModel> {
  return modelFrom(await privateRequest(`/model-catalog/private/${ref.slice('private:'.length)}`,
    jsonInit('PATCH', patch), '保存模型失败'));
}

export async function deletePrivateModel(ref: ModelRef): Promise<void> {
  await privateRequest(`/model-catalog/private/${ref.slice('private:'.length)}`, { method: 'DELETE' }, '删除模型失败');
}

export async function getSelectableModels(): Promise<SafeModel[]> {
  const response = await apiFetch('/model-catalog');
  if (!response.ok) throw new Error('加载模型列表失败');
  const body = await response.json() as { models?: unknown };
  if (!Array.isArray(body.models)) throw new Error('模型列表格式错误');
  return body.models as SafeModel[];
}
