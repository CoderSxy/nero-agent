import type { SkillAvailability, SkillRuntimeManifest } from './types';

export type SkillRuntimeCompatInput = {
  registeredToolIds: Iterable<string>;
  publicNetworkAvailable?: boolean;
  /** Optional script bodies keyed by entrypoint path — used to detect bare outbound HTTP. */
  scriptTexts?: Record<string, string>;
};

const OUTBOUND_HTTP_RE =
  /\b(?:import\s+requests\b|from\s+requests\s+import\b|urllib\.request\b|http\.client\b|fetch\s*\(|axios\b|\bcurl\b)/i;

/**
 * Deployment compatibility report (spec §8).
 * Does not open Docker network, register tools, or retry curl.
 */
export function reportSkillRuntimeCompatibility(
  runtime: SkillRuntimeManifest | null | undefined,
  input: SkillRuntimeCompatInput = { registeredToolIds: [] },
): SkillAvailability {
  if (!runtime) return 'instructions-only';
  if (runtime.entrypoints.length === 0) return 'instructions-only';

  if (runtime.network === 'public' && !input.publicNetworkAvailable) return 'network-unavailable';
  {
    const registered = new Set(input.registeredToolIds);
    if (runtime.requiredTools.some((id) => !registered.has(id))) {
      return 'missing-tools';
    }
  }

  const texts = input.scriptTexts ?? {};
  for (const entry of runtime.entrypoints) {
    const body = texts[entry];
    if (body && OUTBOUND_HTTP_RE.test(body) && runtime.network === 'none') {
      return 'network-unavailable';
    }
  }

  if (runtime.runtimes.length === 0) return 'missing-runtime';

  return 'ready';
}
