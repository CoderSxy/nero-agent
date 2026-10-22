import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPABILITY_TTL_MS,
  capabilityFingerprint,
  freshCapabilities,
  reserveProbeSlot,
  selectStructuredDelivery,
  unknownCapabilities,
  type CapabilityFingerprintInput,
  type ModelCapabilityReport,
} from '../src/mastra/models/capabilities';
import {
  buildProbeRequest,
  createFetchProbeCaller,
  executeCapabilityProbe,
  interpretProbeResponse,
  type CapabilityProbeCaller,
} from '../src/mastra/models/capability-probe';
import { structuredOutputSupport } from '../src/mastra/models/transport';
import { ModelCatalogError } from '../src/mastra/models/types';

const access = (overrides: Partial<CapabilityFingerprintInput> = {}): CapabilityFingerprintInput => ({
  scope: 'private',
  id: '22222222-2222-4222-8222-222222222222',
  ownerId: 'user-a',
  baseUrl: 'https://models.example.test/v1/',
  apiMode: 'chat',
  providerId: 'deepseek',
  modelId: 'v4',
  credentialRevision: 1,
  ...overrides,
});

function caller(mode: 'ok' | 'ignore-tool' | 'bad-nonce' | 'ignore-schema' | 'protocol' | 'status' | 'throw', status = 200): { call: CapabilityProbeCaller; seen: string[] } {
  const seen: string[] = [];
  const call: CapabilityProbeCaller = async (input) => {
    seen.push(input.apiMode);
    assert.equal(input.maxOutputTokens, 256);
    assert.equal(input.tool.function.inputSchema.type, 'object');
    assert.equal(input.tool.function.inputSchema.properties.nonce.const, input.nonce);
    if (mode === 'throw') throw new Error('timeout');
    if (mode === 'protocol') return { httpStatus: 400, protocolUnsupported: true };
    if (mode === 'status') return { httpStatus: status };
    if (input.kind === 'json-schema') {
      return mode === 'ignore-schema'
        ? { httpStatus: 200, json: { summary: 'sunny' } }
        : { httpStatus: 200, json: { nonce: input.nonce, kind: 'probe' } };
    }
    if (mode === 'ignore-tool') return { httpStatus: 200 };
    if (mode === 'bad-nonce') return { httpStatus: 200, toolName: 'echo', arguments: { nonce: 'other' } };
    return { httpStatus: 200, toolName: 'echo', arguments: { nonce: input.nonce } };
  };
  return { call, seen };
}

test('capability probe accepts a provider that returns the nonce for tools and schema', async () => {
  for (const apiMode of ['chat', 'responses'] as const) {
    const { call, seen } = caller('ok');
    const report = await executeCapabilityProbe({ access: access({ apiMode }), roles: ['user'], enabled: true, call, save: async () => undefined });
    assert.equal(report.toolCalling, 'supported');
    assert.equal(report.forcedToolChoice, 'supported');
    assert.equal(report.jsonSchema, 'supported');
    assert.deepEqual(seen, [apiMode, apiMode, apiMode]);
  }
});

test('capability probe marks ignored tools, bad arguments, and ignored schemas unsupported', async () => {
  const ignoredTool = await executeCapabilityProbe({ access: access(), roles: ['user'], enabled: true, call: caller('ignore-tool').call });
  assert.equal(ignoredTool.toolCalling, 'unsupported');
  const badNonce = await executeCapabilityProbe({ access: access({ id: '33333333-3333-4333-8333-333333333333' }), roles: ['user'], enabled: true, call: caller('bad-nonce').call });
  assert.equal(badNonce.forcedToolChoice, 'unsupported');
  const ignoredSchema = await executeCapabilityProbe({ access: access({ id: '44444444-4444-4444-8444-444444444444' }), roles: ['user'], enabled: true, call: caller('ignore-schema').call });
  assert.equal(ignoredSchema.jsonSchema, 'unsupported');
});

test('capability probe keeps timeout, 429, and 5xx unknown and marks explicit protocol errors unsupported', async () => {
  const timeout = await executeCapabilityProbe({ access: access(), roles: ['user'], enabled: true, call: caller('throw').call });
  assert.equal(timeout.toolCalling, 'unknown');
  const limited = await executeCapabilityProbe({ access: access({ credentialRevision: 2 }), roles: ['user'], enabled: true, call: caller('status', 429).call });
  assert.equal(limited.toolCalling, 'unknown');
  const upstream = await executeCapabilityProbe({ access: access({ credentialRevision: 3 }), roles: ['user'], enabled: true, call: caller('status', 503).call });
  assert.equal(upstream.jsonSchema, 'unknown');
  const protocol = await executeCapabilityProbe({ access: access({ credentialRevision: 4 }), roles: ['user'], enabled: true, call: caller('protocol').call });
  assert.equal(protocol.toolCalling, 'unsupported');
  assert.equal(interpretProbeResponse(400, { error: { message: 'response_format is not supported' } }).protocolUnsupported, true);
});

test('capability probe requests stay inside the approved tool schema and never include the api key', async () => {
  for (const apiMode of ['chat', 'responses'] as const) {
    const request = buildProbeRequest({ apiMode, modelId: 'v4', kind: 'tool', nonce: 'abc' });
    const encoded = JSON.stringify(request.body);
    assert.match(encoded, /inputSchema/);
    assert.doesNotMatch(encoded, /sk-|apiKey|authorization/i);
    assert.equal(request.body.max_tokens ?? request.body.max_output_tokens, 256);
  }
  const bodies: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(String(init?.body));
    assert.match(String((init?.headers as Record<string, string>).authorization), /^Bearer sk-test$/);
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'echo', arguments: '{"nonce":"x"}' } }] } }] }), { status: 200 });
  };
  const call = createFetchProbeCaller({ baseUrl: 'https://models.example.test/v1', apiKey: 'sk-test', modelId: 'v4', apiMode: 'chat' }, fetchImpl);
  await call({ kind: 'tool', nonce: 'x', signal: new AbortController().signal, maxOutputTokens: 256, apiMode: 'chat', tool: buildProbeRequest({ apiMode: 'chat', modelId: 'v4', kind: 'tool', nonce: 'x' }).tool });
  assert.doesNotMatch(bodies[0], /sk-test/);
});

test('capability cache isolates owners and expires when the connection or age changes', () => {
  const first = capabilityFingerprint(access());
  const second = capabilityFingerprint(access({ ownerId: 'user-b', id: '55555555-5555-4555-8555-555555555555' }));
  assert.notEqual(first, second);
  assert.notEqual(first, capabilityFingerprint(access({ baseUrl: 'https://other.example.test/v1' })));
  assert.notEqual(first, capabilityFingerprint(access({ apiMode: 'responses' })));
  assert.notEqual(first, capabilityFingerprint(access({ modelId: 'v5' })));
  assert.notEqual(first, capabilityFingerprint(access({ credentialRevision: 2 })));
  const stored: ModelCapabilityReport = { ...unknownCapabilities(first), toolCalling: 'supported', forcedToolChoice: 'supported', jsonSchema: 'supported', checkedAt: new Date(0).toISOString() };
  assert.equal(freshCapabilities(stored, first, CAPABILITY_TTL_MS + 1).toolCalling, 'unknown');
  assert.equal(freshCapabilities({ ...stored, checkedAt: new Date().toISOString() }, first, Date.now()).toolCalling, 'supported');
});

test('capability probes are explicit, rate limited, and hidden from non-admins', async () => {
  const disabled = caller('ok');
  await assert.rejects(
    executeCapabilityProbe({ access: access(), roles: ['admin'], enabled: false, call: disabled.call }),
    (error: unknown) => error instanceof ModelCatalogError && error.code === 'disabled',
  );
  assert.equal(disabled.seen.length, 0);
  const hidden = caller('ok');
  await assert.rejects(
    executeCapabilityProbe({ access: access({ scope: 'public', ownerId: null }), roles: ['user'], enabled: true, call: hidden.call }),
    (error: unknown) => error instanceof ModelCatalogError && error.code === 'not_found',
  );
  assert.equal(hidden.seen.length, 0);
  const busy = new Map<string, { at: number; inflight: boolean }>();
  assert.equal(reserveProbeSlot(busy, 'same-connection', 0), 'ok');
  assert.equal(reserveProbeSlot(busy, 'same-connection', 10), 'busy');
  const slots = new Map();
  const first = caller('ok');
  await executeCapabilityProbe({ access: access(), roles: ['user'], enabled: true, call: first.call, slots, now: 1_000 });
  await assert.rejects(
    executeCapabilityProbe({ access: access(), roles: ['user'], enabled: true, call: caller('ok').call, slots, now: 2_000 }),
    (error: unknown) => error instanceof ModelCatalogError && error.code === 'rate_limited',
  );
});

test('structured delivery follows verified capabilities and leaves unknown models on the compatible path', () => {
  assert.equal(selectStructuredDelivery(null), 'compatible-fallback');
  assert.equal(selectStructuredDelivery(unknownCapabilities()), 'compatible-fallback');
  assert.equal(selectStructuredDelivery({ toolCalling: 'supported', forcedToolChoice: 'supported', jsonSchema: 'supported' }), 'native-schema');
  assert.equal(selectStructuredDelivery({ toolCalling: 'supported', forcedToolChoice: 'unsupported', jsonSchema: 'unsupported' }), 'data-tool');
  assert.equal(selectStructuredDelivery({ toolCalling: 'unsupported', forcedToolChoice: 'unsupported', jsonSchema: 'unsupported' }), 'unavailable');
  assert.equal(structuredOutputSupport(undefined), false);
  assert.equal(structuredOutputSupport('unknown'), false);
  assert.equal(structuredOutputSupport('unsupported'), false);
  assert.equal(structuredOutputSupport('supported'), true);
});
