import assert from 'node:assert/strict';
import test from 'node:test';
import { compareGatewayModels, GATEWAY_BASE_URL, gatewayCatalogUrl, parseGatewayModelList } from '../src/mastra/models/gateway-sync';

test('gateway management catalog uses the root API route', () => {
  assert.equal(gatewayCatalogUrl(), 'https://api.nerosun.cn/api/model-catalog?realm=cn&force=false');
});

test('domestic model center list accepts catalog response and rejects malformed lists', () => {
  assert.deepEqual(parseGatewayModelList({ models: [
    { id: 'glm-5.2', name: 'GLM 5.2' }, { id: 'kimi-k2.7' }, { id: 'glm-5.2' },
  ] }), [
    { modelId: 'glm-5.2', displayName: 'GLM 5.2', catalogMetadata: null, imageSupport: null },
    { modelId: 'kimi-k2.7', displayName: 'kimi-k2.7', catalogMetadata: null, imageSupport: null },
  ]);
  assert.throws(() => parseGatewayModelList({ models: [] }), /模型中心列表/);
  assert.throws(() => parseGatewayModelList({ models: [{ id: '../unsafe' }] }), /模型 ID/);
  assert.deepEqual(parseGatewayModelList({ models: [
    { id: 'auto' }, { id: 'glm-5.2' }, { id: 'global:glm-5.2' }, { id: 'cn:glm-5.2' },
  ] }).map(model => model.modelId), ['auto', 'glm-5.2']);
  assert.throws(() => parseGatewayModelList({ data: [{ id: 'unsupported' }] }), /模型中心列表/);
});

test('catalog metadata preserves limits and only native multimodal models with gateway image input are image-capable', () => {
  const models = parseGatewayModelList({ models: [
    { id: 'vision', name: 'Vision', context_window: 1000000, max_output_tokens: 128000,
      reasoning_efforts: ['low', 'high'], default_reasoning_effort: 'high', credit_multiplier: 0.79,
      native_modality: 'multimodal', provider: '智谱 GLM', supports_images: true, inference_only: true },
    { id: 'audio-only', native_modality: 'multimodal', supports_images: false },
    { id: 'unknown', modality: '待核实' },
  ] });
  assert.deepEqual(models[0], { modelId: 'vision', displayName: 'Vision', imageSupport: true,
    catalogMetadata: { contextWindow: 1000000, maxOutputTokens: 128000,
      reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', creditMultiplier: 0.79,
      modality: 'multimodal', providerName: '智谱 GLM', inferenceOnly: true, imageSupport: true } });
  assert.equal(models[1].imageSupport, false);
  assert.equal(models[2].imageSupport, null);
  assert.equal(models[2].catalogMetadata?.modality, 'unverified');
});

test('real gateway field names distinguish native modality from gateway image input', () => {
  const models = parseGatewayModelList({ models: [
    { id: 'glm-5.3', name: 'GLM-5.3', native_modality: 'text', supports_images: true,
      context_length: 1000000, max_output_tokens: 64000, efforts: ['low', 'high', 'max'],
      default_effort: 'high', credits: 'x0.79', series: '智谱 GLM', only_reasoning: true,
      description: '旗舰模型' },
    { id: 'glm-5.1', native_modality: 'text', supports_images: null, image_input_conflict: true },
  ] });
  assert.equal(models[0].imageSupport, false);
  assert.deepEqual(models[0].catalogMetadata, { contextWindow: 1000000, maxOutputTokens: 64000,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high',
    creditMultiplier: 0.79, creditLabel: 'x0.79', modality: 'text', providerName: '智谱 GLM', inferenceOnly: true,
    description: '旗舰模型', imageSupport: false });
  assert.equal(models[1].imageSupport, false);
  assert.equal(models[1].catalogMetadata?.imageInputConflict, true);
  assert.equal(models[1].catalogMetadata?.modality, 'text');
});

test('unknown and router native modalities never inherit platform image support', () => {
  const models = parseGatewayModelList({ models: [
    { id: 'hy3-x', native_modality: 'unknown', supports_images: true, image_input_conflict: false },
    { id: 'auto', native_modality: 'router', supports_images: true },
    { id: 'vision-conflict', native_modality: 'multimodal', supports_images: true, image_input_conflict: true },
    { id: 'vision-unknown', native_modality: 'multimodal', supports_images: null },
    { id: 'legacy', supports_images: true },
  ] });
  assert.deepEqual(models.map(model => model.imageSupport), [false, false, false, false, null]);
});

test('gateway comparison preserves local models and shows new, existing and missing entries', () => {
  const diff = compareGatewayModels(
    parseGatewayModelList({ models: [{ id: 'glm-5.2', name: 'GLM 5.2' }, { id: 'kimi-k2.7', name: 'Kimi' }] }),
    [{ ref: 'public:one', modelId: 'glm-5.2', displayName: '我的 GLM', baseUrl: GATEWAY_BASE_URL },
      { ref: 'public:two', modelId: 'old', displayName: '旧模型', baseUrl: GATEWAY_BASE_URL },
      { ref: 'public:three', modelId: 'kimi-k2.7', displayName: '其他来源', baseUrl: 'https://other.example/v1' }],
  );
  assert.equal(diff.incoming[0].status, 'existing');
  assert.equal(diff.incoming[0].displayName, '我的 GLM');
  assert.equal(diff.incoming[0].imageSupport, null);
  assert.equal(diff.incoming[1].status, 'new');
  assert.deepEqual(diff.missing.map(item => item.modelId), ['old']);
});
