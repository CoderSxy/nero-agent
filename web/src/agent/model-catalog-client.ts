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

export async function getSelectableModels(): Promise<SafeModel[]> {
  const response = await apiFetch('/model-catalog');
  if (!response.ok) throw new Error('加载模型列表失败');
  const body = await response.json() as { models?: unknown };
  if (!Array.isArray(body.models)) throw new Error('模型列表格式错误');
  return body.models as SafeModel[];
}
