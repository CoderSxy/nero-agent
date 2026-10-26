import assert from 'node:assert/strict';
import test from 'node:test';
import { createDockerodeEngine } from '../src/mastra/sandbox/docker/client';
import { createDockerReadinessProbe } from '../src/mastra/skills/readiness-probe';
import { parseRuntimeManifest } from '../src/mastra/skills/package';

test('real Docker readiness uses fresh task venv, distinguishes missing packages, and leaves no containers', { skip: process.env.SKILL_READINESS_DOCKER_INTEGRATION !== 'true' }, async () => {
  const engine = await createDockerodeEngine();
  const localId = await engine.resolveImageId!(process.env.SKILL_READINESS_TEST_IMAGE ?? 'nero-runtime:public-network');
  const image = `readiness-local@${localId}`;
  for (const advanced of [false, true]) {
    const probe = createDockerReadinessProbe({ engine: async () => engine, image: () => image, dependenciesEnabled: () => advanced, advancedRuntime: () => advanced });
    const runtime = parseRuntimeManifest(Buffer.from(JSON.stringify({ schemaVersion: 2, runtimes: ['python3', 'node'], entrypoints: ['scripts/demo.py'], requiredTools: [], network: 'none', runtimeVersions: { python3: '>=3.0.0', node: '>=22.0.0' }, dependencies: { python: [{ name: 'nero-nonexistent-package' }, { name: 'pip', module: 'pip._internal' }, { name: 'pip', module: 'pip.nero_nonexistent_submodule' }], node: [{ name: 'nero-nonexistent-package' }], commands: [{ name: 'nero-nonexistent-command' }] } })));
    const report = await probe(runtime);
    assert.ok(report.some(item => item.kind === 'runtime' && item.name === 'python3' && item.status === 'ok'));
    assert.ok(report.some(item => item.kind === 'runtime' && item.name === 'node' && item.status === 'ok'));
    assert.ok(report.some(item => item.kind === 'python' && item.name === 'pip' && item.status === 'ok'));
    assert.ok(report.some(item => item.kind === 'python' && item.name === 'pip' && item.status === 'missing'));
    for (const kind of ['python', 'node', 'command']) assert.ok(report.some(item => item.kind === kind && item.status === 'missing'), JSON.stringify(report));
  }
  assert.equal((await engine.findLabeled('nero.skill-readiness', '1')).length, 0);
});
