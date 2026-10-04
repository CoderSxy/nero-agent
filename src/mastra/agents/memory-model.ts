import { createHash } from 'node:crypto';
import { Memory } from '@mastra/memory';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type { RequestContext } from '@mastra/core/request-context';
import { resolveSelectedModel } from '../models/resolver';
import { redactSecrets } from '../models/redact';
import { ModelCatalogError } from '../models/types';

const MAX_CACHED_MEMORIES = 200;
const memoryInstances = new Map<string, Memory>();

/** Used whenever no authorized model could be resolved: no provider is ever reached. */
const modellessMemory = new Memory({ options: { generateTitle: false } });

function cacheKeyFor(config: OpenAICompatibleConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function memoryFor(config: OpenAICompatibleConfig): Memory {
  const key = cacheKeyFor(config);
  let memory = memoryInstances.get(key);
  if (!memory) {
    memory = new Memory({ options: {
      generateTitle: { model: config },
      observationalMemory: {
        observation: { model: config },
        reflection: { model: config },
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

export async function memoryForRequest({ requestContext }: { requestContext: RequestContext }): Promise<Memory> {
  try {
    const { config } = await resolveSelectedModel(requestContext, 'memory');
    return memoryFor(config);
  } catch (error) {
    const code = error instanceof ModelCatalogError ? error.code : undefined;
    console.warn('memory model unavailable; using model-less memory', {
      error: error instanceof Error ? error.name : 'unknown',
      ...(error instanceof Error ? { message: redactSecrets(error.message) } : {}),
      ...(code ? { code } : {}),
    });
    return modellessMemory;
  }
}
