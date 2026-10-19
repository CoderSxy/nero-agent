import type { Processor } from '@mastra/core/processors';
import { createTemporalContext, formatTemporalContext, resolveTemporalTimezone, type TemporalContext } from './context';

/** State belongs to one Mastra execution, never to a shared/reused RequestContext. */
export function createTemporalProcessor({ now = () => new Date() }: { now?: () => Date } = {}) {
  return {
    id: 'temporal-context',
    processLLMRequest({ prompt, state, requestContext, tracingContext }) {
      const current = createTemporalContext(now(), resolveTemporalTimezone(requestContext));
      const previous = state.snapshot as TemporalContext | undefined;
      const snapshot = previous?.date === current.date && previous.timezone === current.timezone ? previous : current;
      state.snapshot = snapshot;
      tracingContext?.currentSpan?.update({ metadata: { temporal: snapshot } });
      // Provider-only mutation: neither conversation history nor observational memory keeps this clock.
      const withoutPreviousClock = prompt.filter(message => !(message.role === 'system'
        && message.content.startsWith('<current-time>')));
      return { prompt: [{ role: 'system', content: formatTemporalContext(snapshot) }, ...withoutPreviousClock] };
    },
  } satisfies Processor;
}

export const temporalProcessor = createTemporalProcessor();
