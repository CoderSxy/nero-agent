import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type { RequestContext } from '@mastra/core/request-context';
import type { AuthUser } from '../auth/service';
import { decryptApiKey } from './crypto';
import { assertAllowedEndpoint, normalizeModelEndpoint } from './endpoint-policy';
import { listEnabledPublic } from './repository';
import { findAuthorizedModel } from './service';
import { ModelCatalogError, parseModelRef, toModelRef, type ModelRef } from './types';

export const chatModelRefContextKey = 'nero-agent.chat-model-ref';
export const memoryModelRefContextKey = 'nero-agent.memory-model-ref';
/** Server-only identity slot. Never read the client-writable `user` key. */
export const trustedUserContextKey = 'nero-agent.trusted-user';

/** Reserved by @mastra/server: clients cannot populate it, auth middleware sets it. */
const MASTRA_USER_KEY = 'mastra__user';

export type ModelPurpose = 'chat' | 'memory';

export type SelectedModel = { ref: ModelRef; config: OpenAICompatibleConfig };

function isAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AuthUser>;
  return typeof candidate.id === 'string' && candidate.id.length > 0 && Array.isArray(candidate.roles);
}

export function trustedUserFrom(requestContext: RequestContext): AuthUser {
  const user = requestContext.get(trustedUserContextKey) ?? requestContext.get(MASTRA_USER_KEY);
  if (!isAuthUser(user)) {
    throw new ModelCatalogError('forbidden', 'Authentication is required to use a model');
  }
  return user;
}

export async function resolveModel(ref: ModelRef, user: AuthUser): Promise<OpenAICompatibleConfig> {
  const record = await findAuthorizedModel(ref, user);
  const url = normalizeModelEndpoint(record.baseUrl);
  await assertAllowedEndpoint(url);
  return {
    id: `${record.providerId}/${record.modelId}`,
    url: record.baseUrl,
    apiKey: decryptApiKey(record.apiKeyCiphertext),
    api: record.apiMode,
  };
}

function readRef(requestContext: RequestContext, key: string): ModelRef | undefined {
  const value = requestContext.get(key);
  if (value === undefined || value === null) return undefined;
  if (!parseModelRef(value)) {
    throw new ModelCatalogError('invalid_input', 'Model reference is invalid');
  }
  return value as ModelRef;
}

async function defaultPublicRef(): Promise<ModelRef> {
  const models = await listEnabledPublic();
  const fallback = models.find((model) => model.isDefault);
  if (!fallback) throw new ModelCatalogError('no_public_models', '请先配置公共模型');
  return toModelRef('public', fallback.id);
}

export async function resolveSelectedModel(
  requestContext: RequestContext,
  purpose: ModelPurpose,
): Promise<SelectedModel> {
  const user = trustedUserFrom(requestContext);
  const chatRef = readRef(requestContext, chatModelRefContextKey);
  const memoryRef = purpose === 'memory' ? readRef(requestContext, memoryModelRefContextKey) : undefined;
  const ref = memoryRef ?? chatRef ?? (await defaultPublicRef());
  return { ref, config: await resolveModel(ref, user) };
}
