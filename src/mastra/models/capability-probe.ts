import { randomBytes } from 'node:crypto';
import {
  CAPABILITY_PROBE_CALL_MS,
  CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
  CAPABILITY_PROBE_TOTAL_MS,
  CAPABILITY_PROBE_VERSION,
  capabilityFingerprint,
  finishProbeSlot,
  reserveProbeSlot,
  type CapabilityFingerprintInput,
  type CapabilityState,
  type ModelCapabilityReport,
  type ProbeSlot,
} from './capabilities';
import { createGuardedModelFetch } from './transport';
import { ModelCatalogError } from './types';

export type ProbeKind = 'tool' | 'forced-tool' | 'json-schema';

export type ProbeExchange = {
  httpStatus: number;
  toolName?: string;
  arguments?: unknown;
  json?: unknown;
  protocolUnsupported?: boolean;
};

export type CapabilityProbeCaller = (input: {
  kind: ProbeKind;
  nonce: string;
  signal: AbortSignal;
  maxOutputTokens: number;
  apiMode: 'chat' | 'responses';
  tool: ReturnType<typeof echoToolSchema>;
}) => Promise<ProbeExchange>;

export function echoToolSchema(nonce: string) {
  const inputSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['nonce'],
    properties: { nonce: { type: 'string', const: nonce } },
  };
  return {
    type: 'function' as const,
    function: {
      name: 'echo',
      description: 'Return the supplied nonce and nothing else.',
      parameters: inputSchema,
      inputSchema,
    },
  };
}

export function buildProbeRequest(input: {
  apiMode: 'chat' | 'responses';
  modelId: string;
  kind: ProbeKind;
  nonce: string;
}): { path: string; body: Record<string, unknown>; tool: ReturnType<typeof echoToolSchema> } {
  const tool = echoToolSchema(input.nonce);
  const instruction = input.kind === 'json-schema'
    ? 'Reply with the required JSON object only.'
    : 'Call the echo tool with the required nonce. Do not answer in prose.';
  if (input.apiMode === 'responses') {
    const body: Record<string, unknown> = {
      model: input.modelId,
      input: [{ role: 'user', content: instruction }],
      max_output_tokens: CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
    };
    if (input.kind === 'json-schema') {
      body.text = { format: { type: 'json_schema', name: 'probe', strict: true, schema: schemaFor(input.nonce) } };
    } else {
      body.tools = [{ type: 'function', name: 'echo', parameters: tool.function.parameters, inputSchema: tool.function.inputSchema }];
      body.tool_choice = input.kind === 'forced-tool' ? { type: 'function', name: 'echo' } : 'auto';
    }
    return { path: '/responses', body, tool };
  }
  const body: Record<string, unknown> = {
    model: input.modelId,
    messages: [{ role: 'user', content: instruction }],
    max_tokens: CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
  };
  if (input.kind === 'json-schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema: schemaFor(input.nonce) } };
  } else {
    body.tools = [tool];
    body.tool_choice = input.kind === 'forced-tool' ? { type: 'function', function: { name: 'echo' } } : 'auto';
  }
  return { path: '/chat/completions', body, tool };
}

function schemaFor(nonce: string) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['nonce', 'kind'],
    properties: { nonce: { type: 'string', const: nonce }, kind: { type: 'string', enum: ['probe'] } },
  };
}

export function interpretProbeResponse(status: number, body: unknown): ProbeExchange {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const errorText = JSON.stringify(record.error ?? '').toLowerCase();
  if (status === 400 && /not support|unsupported|unknown parameter/.test(errorText)) {
    return { httpStatus: status, protocolUnsupported: true };
  }
  const choice = Array.isArray(record.choices) ? record.choices[0] as { message?: { content?: unknown; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } } : undefined;
  const call = choice?.message?.tool_calls?.[0]?.function;
  const output = Array.isArray(record.output) ? record.output as Array<Record<string, unknown>> : [];
  const responseCall = output.find(item => item.type === 'function_call');
  const toolName = call?.name ?? (typeof responseCall?.name === 'string' ? responseCall.name : undefined);
  const rawArguments = call?.arguments ?? responseCall?.arguments;
  let parsedArguments: unknown;
  if (typeof rawArguments === 'string') {
    try { parsedArguments = JSON.parse(rawArguments); } catch { parsedArguments = undefined; }
  } else if (rawArguments && typeof rawArguments === 'object') parsedArguments = rawArguments;
  const content = choice?.message?.content ?? output.find(item => item.type === 'message')?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(part => typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '').join('')
    : '';
  let json: unknown;
  if (text) {
    try { json = JSON.parse(text); } catch { json = undefined; }
  }
  return { httpStatus: status, toolName, arguments: parsedArguments, json };
}

function stateFrom(exchange: ProbeExchange, accept: (exchange: ProbeExchange) => boolean): CapabilityState {
  if (exchange.protocolUnsupported) return 'unsupported';
  if (exchange.httpStatus === 408 || exchange.httpStatus === 429 || exchange.httpStatus >= 500 || exchange.httpStatus >= 400) return 'unknown';
  return accept(exchange) ? 'supported' : 'unsupported';
}

export async function runCapabilityProbe(input: {
  apiMode: 'chat' | 'responses';
  signal?: AbortSignal;
  call: CapabilityProbeCaller;
  now?: () => number;
}): Promise<Omit<ModelCapabilityReport, 'fingerprint'>> {
  const started = (input.now ?? Date.now)();
  const parent = input.signal ?? new AbortController().signal;
  const reasons: string[] = [];
  const runOne = async (kind: ProbeKind, accept: (exchange: ProbeExchange, nonce: string) => boolean): Promise<CapabilityState> => {
    if (parent.aborted || (input.now ?? Date.now)() - started > CAPABILITY_PROBE_TOTAL_MS) {
      reasons.push(`${kind}:deadline`);
      return 'unknown';
    }
    const nonce = randomBytes(8).toString('hex');
    const signal = AbortSignal.any([parent, AbortSignal.timeout(CAPABILITY_PROBE_CALL_MS)]);
    try {
      const exchange = await input.call({
        kind, nonce, signal, maxOutputTokens: CAPABILITY_PROBE_MAX_OUTPUT_TOKENS, apiMode: input.apiMode, tool: echoToolSchema(nonce),
      });
      const state = stateFrom(exchange, item => accept(item, nonce));
      if (state !== 'supported') reasons.push(`${kind}:${state}`);
      return state;
    } catch {
      reasons.push(`${kind}:unknown`);
      return 'unknown';
    }
  };
  const acceptsTool = (exchange: ProbeExchange, nonce: string) =>
    exchange.toolName === 'echo' && (exchange.arguments as { nonce?: string } | undefined)?.nonce === nonce;
  const toolCalling = await runOne('tool', acceptsTool);
  const forcedToolChoice = await runOne('forced-tool', acceptsTool);
  const jsonSchema = await runOne('json-schema', (exchange, nonce) => {
    const body = exchange.json;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const record = body as Record<string, unknown>;
    return record.nonce === nonce && record.kind === 'probe' && Object.keys(record).every(key => key === 'nonce' || key === 'kind');
  });
  return {
    toolCalling,
    forcedToolChoice,
    jsonSchema,
    checkedAt: new Date(started).toISOString(),
    safeReason: reasons.length ? reasons.join(',') : null,
    probeVersion: CAPABILITY_PROBE_VERSION,
  };
}

export async function executeCapabilityProbe(input: {
  access: CapabilityFingerprintInput;
  roles: readonly string[];
  enabled?: boolean;
  signal?: AbortSignal;
  call: CapabilityProbeCaller;
  now?: number;
  slots?: Map<string, ProbeSlot>;
  save?: (report: ModelCapabilityReport) => Promise<void>;
}): Promise<ModelCapabilityReport> {
  if (input.enabled === false) throw new ModelCatalogError('disabled', '模型能力检测已关闭，不会发起请求');
  if (input.access.scope === 'public' && !input.roles.includes('admin')) {
    throw new ModelCatalogError('not_found', '模型不存在');
  }
  const fingerprint = capabilityFingerprint(input.access);
  const slots = input.slots ?? new Map<string, ProbeSlot>();
  const now = input.now ?? Date.now();
  const slot = reserveProbeSlot(slots, fingerprint, now);
  if (slot !== 'ok') throw new ModelCatalogError('rate_limited', '能力检测正在进行或刚刚执行过，请稍后再试');
  try {
    const report = { ...await runCapabilityProbe({ apiMode: input.access.apiMode, signal: input.signal, call: input.call, now: () => input.now ?? Date.now() }), fingerprint };
    await input.save?.(report);
    return report;
  } finally {
    finishProbeSlot(slots, fingerprint, input.now ?? Date.now());
  }
}

export function createFetchProbeCaller(config: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  apiMode: 'chat' | 'responses';
}, fetchImpl?: typeof fetch): CapabilityProbeCaller {
  const base = config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`;
  const guarded = createGuardedModelFetch(new URL(base), fetchImpl);
  return async (input) => {
    const request = buildProbeRequest({ apiMode: config.apiMode, modelId: config.modelId, kind: input.kind, nonce: input.nonce });
    const response = await guarded(new URL(request.path.slice(1), base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(request.body),
      signal: input.signal,
    });
    const body = await response.json().catch(() => ({}));
    return interpretProbeResponse(response.status, body);
  };
}
