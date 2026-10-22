import { createHash } from 'node:crypto';

export const CAPABILITY_PROBE_VERSION = 'phase1-v1';
export const CAPABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CAPABILITY_PROBE_MIN_INTERVAL_MS = 60_000;
export const CAPABILITY_PROBE_CALL_MS = 10_000;
export const CAPABILITY_PROBE_TOTAL_MS = 30_000;
export const CAPABILITY_PROBE_MAX_OUTPUT_TOKENS = 256;
export const MODEL_CAPABILITIES_CONTEXT_KEY = 'nero-agent.model-capabilities';

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';
export type StructuredDelivery = 'native-schema' | 'data-tool' | 'compatible-fallback' | 'unavailable';

export type ModelCapabilityReport = {
  toolCalling: CapabilityState;
  forcedToolChoice: CapabilityState;
  jsonSchema: CapabilityState;
  checkedAt: string | null;
  safeReason: string | null;
  probeVersion: string;
  fingerprint: string;
};

export type CapabilityFingerprintInput = {
  scope: 'public' | 'private';
  id: string;
  ownerId: string | null;
  baseUrl: string;
  apiMode: 'chat' | 'responses';
  providerId: string;
  modelId: string;
  credentialRevision: number;
};

export function isCapabilityProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MODEL_CAPABILITY_PROBE_ENABLED === 'true';
}

export function capabilityFingerprint(input: CapabilityFingerprintInput): string {
  const url = new URL(input.baseUrl);
  const normalized = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return createHash('sha256').update(JSON.stringify({
    scope: input.scope,
    id: input.id,
    ownerId: input.ownerId ?? '',
    baseUrl: normalized,
    apiMode: input.apiMode,
    providerId: input.providerId,
    modelId: input.modelId,
    credentialRevision: input.credentialRevision,
    probeVersion: CAPABILITY_PROBE_VERSION,
  })).digest('hex');
}

export function unknownCapabilities(fingerprint = ''): ModelCapabilityReport {
  return {
    toolCalling: 'unknown',
    forcedToolChoice: 'unknown',
    jsonSchema: 'unknown',
    checkedAt: null,
    safeReason: null,
    probeVersion: CAPABILITY_PROBE_VERSION,
    fingerprint,
  };
}

export function freshCapabilities(
  stored: ModelCapabilityReport | null,
  fingerprint: string,
  now: number,
): ModelCapabilityReport {
  if (!stored || stored.fingerprint !== fingerprint || !stored.checkedAt) return unknownCapabilities(fingerprint);
  if (now - Date.parse(stored.checkedAt) > CAPABILITY_TTL_MS) return unknownCapabilities(fingerprint);
  return stored;
}

/** No silent model switch. Unknown stays on the bounded compatible path. */
export function selectStructuredDelivery(capabilities: Pick<ModelCapabilityReport, 'toolCalling' | 'forcedToolChoice' | 'jsonSchema'> | null | undefined): StructuredDelivery {
  if (!capabilities) return 'compatible-fallback';
  if (capabilities.jsonSchema === 'unknown' || capabilities.toolCalling === 'unknown') return 'compatible-fallback';
  if (capabilities.jsonSchema === 'supported') return 'native-schema';
  if (capabilities.toolCalling === 'supported' || capabilities.forcedToolChoice === 'supported') return 'data-tool';
  return 'unavailable';
}

export type ProbeSlot = { at: number; inflight: boolean };

export function reserveProbeSlot(
  slots: Map<string, ProbeSlot>,
  key: string,
  now: number,
): 'ok' | 'recent' | 'busy' {
  const current = slots.get(key);
  if (current?.inflight) return 'busy';
  if (current && now - current.at < CAPABILITY_PROBE_MIN_INTERVAL_MS) return 'recent';
  slots.set(key, { at: now, inflight: true });
  return 'ok';
}

export function finishProbeSlot(slots: Map<string, ProbeSlot>, key: string, now: number): void {
  const current = slots.get(key);
  slots.set(key, { at: current?.at ?? now, inflight: false });
}
