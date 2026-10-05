import assert from 'node:assert/strict';
import test from 'node:test';
import { compareGatewayModels, parseGatewayModelList } from '../src/mastra/models/gateway-sync';

test('domestic model center list accepts catalog response and rejects malformed lists', () => {
  assert.deepEqual(parseGatewayModelList({ models: [
    { id: 'glm-5.2', name: 'GLM 5.2' }, { id: 'kimi-k2.7' }, { id: 'glm-5.2' },
  ] }), [{ modelId: 'glm-5.2', displayName: 'GLM 5.2' }, { modelId: 'kimi-k2.7', displayName: 'kimi-k2.7' }]);
  assert.throws(() => parseGatewayModelList({ models: [] }), /模型中心列表/);
  assert.throws(() => parseGatewayModelList({ models: [{ id: '../unsafe' }] }), /模型 ID/);
  assert.deepEqual(parseGatewayModelList({ models: [
    { id: 'auto' }, { id: 'glm-5.2' }, { id: 'global:glm-5.2' }, { id: 'cn:glm-5.2' },
  ] }).map(model => model.modelId), ['auto', 'glm-5.2']);
  assert.throws(() => parseGatewayModelList({ data: [{ id: 'unsupported' }] }), /模型中心列表/);
});

test('gateway comparison preserves local models and shows new, existing and missing entries', () => {
  const diff = compareGatewayModels(
    parseGatewayModelList({ models: [{ id: 'glm-5.2', name: 'GLM 5.2' }, { id: 'kimi-k2.7', name: 'Kimi' }] }),
    [{ ref: 'public:one', modelId: 'glm-5.2', displayName: '我的 GLM', baseUrl: 'http://101.37.135.116:7864/v1' },
      { ref: 'public:two', modelId: 'old', displayName: '旧模型', baseUrl: 'http://101.37.135.116:7864/v1' },
      { ref: 'public:three', modelId: 'kimi-k2.7', displayName: '其他来源', baseUrl: 'https://other.example/v1' }],
  );
  assert.equal(diff.incoming[0].status, 'existing');
  assert.equal(diff.incoming[0].displayName, '我的 GLM');
  assert.equal(diff.incoming[1].status, 'new');
  assert.deepEqual(diff.missing.map(item => item.modelId), ['old']);
});
