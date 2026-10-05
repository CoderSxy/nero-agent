import { createHash } from 'node:crypto';
import { Memory } from '@mastra/memory';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type { RequestContext } from '@mastra/core/request-context';
import { resolveSelectedModel } from '../models/resolver';
import { createTransportModel } from '../models/transport';

const MAX_CACHED_MEMORIES = 200;
const memoryInstances = new Map<string, Memory>();


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
      observationalMemory: {
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

export async function memoryForRequest({ requestContext }: { requestContext: RequestContext }): Promise<Memory> {
  const { config } = await resolveSelectedModel(requestContext, 'memory');
  return memoryFor(config);
}
