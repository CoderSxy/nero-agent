import { createHash } from 'node:crypto';
import { Memory } from '@mastra/memory';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type { RequestContext } from '@mastra/core/request-context';
import { decryptApiKey } from '../models/crypto';
import { assertAllowedEndpoint, normalizeModelEndpoint } from '../models/endpoint-policy';
import { listEnabledPublic } from '../models/repository';
import { resolveSelectedModel } from '../models/resolver';
import { createTransportModel } from '../models/transport';
import { ModelCatalogError } from '../models/types';

const MAX_CACHED_MEMORIES = 200;
const memoryInstances = new Map<string, Memory>();
const MASTRA_USER_KEY = 'mastra__user';

function cacheKeyFor(config: OpenAICompatibleConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function memoryFor(config: OpenAICompatibleConfig): Memory {
  const key = cacheKeyFor(config);
  let memory = memoryInstances.get(key);
  if (!memory) {
    const model = createTransportModel(config);
    memory = new Memory({ options: {
      generateTitle: { model },
      semanticRecall: false,
      workingMemory: { enabled: false },
      observationalMemory: {
        scope: 'thread',
        retrieval: { scope: 'thread' },
        observation: { model },
        reflection: { model },
      },
    } });
    if (memoryInstances.size >= MAX_CACHED_MEMORIES) {
      const oldest = memoryInstances.keys().next().value;
      if (oldest !== undefined) memoryInstances.delete(oldest);
    }
    memoryInstances.set(key, memory);
  }
  return memory;
}

/**
 * Read-only-safe memory for schedule worker pre-checks that call
 * `agent.getMemory()` with an empty RequestContext (no `mastra__user`).
 * Authenticated requests still go through `trustedUser` via resolveSelectedModel.
 */
async function memoryForMissingRequestContext(): Promise<Memory> {
  const models = await listEnabledPublic();
  const fallback = models.find((model) => model.isDefault) ?? models[0];
  if (!fallback) throw new ModelCatalogError('no_public_models', '请先配置公共模型');
  const url = normalizeModelEndpoint(fallback.baseUrl);
  await assertAllowedEndpoint(url);
  return memoryFor({
    id: `${fallback.providerId}/${fallback.modelId}`,
    url: url.toString(),
    apiKey: decryptApiKey(fallback.apiKeyCiphertext),
    api: fallback.apiMode,
  });
}

export async function memoryForRequest({ requestContext }: { requestContext?: RequestContext }): Promise<Memory> {
  const hasUser = requestContext != null && requestContext.get(MASTRA_USER_KEY) != null;
  if (!hasUser) return memoryForMissingRequestContext();
  const { config } = await resolveSelectedModel(requestContext, 'memory');
  return memoryFor(config);
}
