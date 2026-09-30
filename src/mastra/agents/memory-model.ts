import { Memory } from '@mastra/memory';
import type { RequestContext } from '@mastra/core/request-context';

export const DEFAULT_MEMORY_MODEL = 'deepseek/deepseek-v4-flash';
const memoryInstances = new Map<string, Memory>();

export function memoryForRequest({ requestContext }: { requestContext: RequestContext }): Memory {
  const requested = requestContext.get('nero-agent.memory-model');
  const model = typeof requested === 'string' && /^[a-z][\w-]*\/[a-z\d][\w.\-]*$/i.test(requested)
    ? requested : DEFAULT_MEMORY_MODEL;
  let memory = memoryInstances.get(model);
  if (!memory) {
    memory = new Memory({ options: {
      generateTitle: true,
      observationalMemory: {
        observation: { model },
        reflection: { model },
      },
    } });
    memoryInstances.set(model, memory);
  }
  return memory;
}
