import assert from 'node:assert/strict';
import test from 'node:test';
import { GATEWAY_BASE_URL } from '../src/mastra/models/gateway-sync';
import { effectiveModelSupportsVision } from '../src/mastra/models/service';

test('gateway image eligibility requires reviewed native multimodality and confirmed platform input', () => {
  const model = (modality: 'text' | 'multimodal' | 'unverified' | 'router', imageSupport: boolean | null) => ({
    baseUrl: GATEWAY_BASE_URL, supportsVision: true,
    catalogMetadata: { modality, imageSupport },
  });
  assert.equal(effectiveModelSupportsVision(model('text', true)), false);
  assert.equal(effectiveModelSupportsVision(model('unverified', true)), false);
  assert.equal(effectiveModelSupportsVision(model('router', true)), false);
  assert.equal(effectiveModelSupportsVision(model('multimodal', null)), false);
  assert.equal(effectiveModelSupportsVision(model('multimodal', true)), true);
  assert.equal(effectiveModelSupportsVision({ ...model('multimodal', true),
    catalogMetadata: { modality: 'multimodal', imageSupport: true, imageInputConflict: true } }), false);
  assert.equal(effectiveModelSupportsVision({ ...model('multimodal', true), supportsVision: false }), false);
});

test('manual models on other gateways retain their configured image capability', () => {
  assert.equal(effectiveModelSupportsVision({ baseUrl: 'https://other.example/v1',
    supportsVision: true, catalogMetadata: null }), true);
});
