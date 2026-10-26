import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRuntimeManifest } from '../src/mastra/skills/package';

const manifest = { schemaVersion: 2, runtimes: ['python3'], entrypoints: ['scripts/main.py'], requiredTools: [], network: 'none', dependencies: { python: [{ name: 'python-pptx', version: '>=1.0.0', module: 'pptx' }] } };
test('v2 dependency declaration survives parsing; rejects unsafe names and version expressions', () => {
  const parsed = parseRuntimeManifest(Buffer.from(JSON.stringify(manifest)));
  assert.deepEqual(parsed.dependencies, manifest.dependencies);
  for (const dependency of [{ name: 'x;touch /tmp/a' }, { name: 'x', version: 'whatever' }, { name: 'x', module: '../../x' }]) {
    assert.throws(() => parseRuntimeManifest(Buffer.from(JSON.stringify({ ...manifest, dependencies: { python: [dependency] } }))));
  }
});
test('v1 declarations remain compatible', () => {
  const { dependencies, ...v1 } = manifest;
  assert.equal(parseRuntimeManifest(Buffer.from(JSON.stringify({ ...v1, schemaVersion: 1 }))).schemaVersion, 1);
});

import { createReadinessChecker } from '../src/mastra/skills/readiness';
const baseInput = { skillMd: '# test', files: [{ path: 'scripts/main.py', hash: 'a' }], runtime: manifest, toolIds: [] } as any;
test('missing dependencies block readiness; environment and content invalidate cached results', async () => {
  let calls = 0, fingerprint = 'image1';
  const checker = createReadinessChecker({ environment: () => ({ fingerprint, enabled: true, scriptEnabled: true, publicNetwork: false }), probe: async () => { calls++; return [{ kind: 'python', name: 'python-pptx', status: 'missing', message: '缺少 Python 包 python-pptx' }]; } });
  assert.equal((await checker.check(baseInput)).status, 'blocked');
  await checker.check(baseInput); assert.equal(calls, 1);
  fingerprint = 'image2'; await checker.check(baseInput); assert.equal(calls, 2);
  await checker.check({ ...baseInput, skillMd: '# changed' }); assert.equal(calls, 3);
});
test('instructions, undeclared scripts, infrastructure failure, and checks without tools are distinct', async () => {
  const checker = createReadinessChecker({ environment: () => ({ fingerprint: 'image', enabled: true, scriptEnabled: true, publicNetwork: false }), probe: async () => { throw new Error('private host secret'); } });
  assert.equal((await checker.check({ ...baseInput, runtime: null, files: [] })).status, 'instructions-only');
  assert.equal((await checker.check({ ...baseInput, runtime: null })).status, 'needs-declaration');
  const failed = await checker.check(baseInput);
  assert.equal(failed.status, 'failed'); assert.ok(!JSON.stringify(failed).includes('private host secret'));
  assert.equal((await checker.check({ ...baseInput, runtime: { ...manifest, requiredTools: ['missing-tool'] } })).status, 'blocked');
});
import { createDockerReadinessProbe } from '../src/mastra/skills/readiness-probe';
test('probe isolates workspace, reports missing packages and always removes container', async () => {
  let options: any, removed = 0;
  const engine: any = { create: async (o: any) => { options = o; return { id: 'probe' }; }, start: async () => {}, remove: async () => { removed++; }, exec: async (_id: string, cmd: string, args: string[]) => {
    if (args.includes('--version')) return { exitCode: 0, stdout: 'Python 3.13.0', stderr: '' };
    if (args[1]?.includes('importlib.metadata')) return { exitCode: 0, stdout: 'null', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  } };
  const probe = createDockerReadinessProbe({ engine: async () => engine, image: () => 'sandbox@sha256:' + 'a'.repeat(64), dependenciesEnabled: () => false, advancedRuntime: () => false });
  const result = await probe(manifest as any);
  assert.ok(result.some(item => item.name === 'python-pptx' && item.status === 'missing'));
  assert.deepEqual(options.HostConfig.Binds, []); assert.equal(options.User, '10001:10001');
  assert.equal(options.HostConfig.NetworkMode, 'none'); assert.equal(removed, 1);
  engine.exec = async () => { throw new Error('Docker unavailable'); };
  await assert.rejects(() => probe(manifest as any)); assert.equal(removed, 2);
});
test('expired results and changed actor tools are rechecked, changing config mid-probe never passes', async () => {
  let now = 0, calls = 0, environment = 'one';
  const checker = createReadinessChecker({ now: () => now, environment: () => ({ fingerprint: environment, enabled: true, scriptEnabled: true, publicNetwork: false }), probe: async () => { calls++; if (calls === 4) environment = 'changed'; return []; } });
  assert.equal((await checker.check(baseInput)).status, 'ready');
  now = 300001; await checker.check(baseInput); assert.equal(calls, 2);
  await checker.check({ ...baseInput, toolIds: ['new-tool'] }); assert.equal(calls, 3);
  assert.equal((await checker.check(baseInput, true)).status, 'failed');
});
test('stable version comparisons enforce bounds and reject unsafe or unsupported ranges', async () => {
  const { satisfiesVersion } = await import('../src/mastra/skills/runtime-dependencies');
  assert.equal(satisfiesVersion('1.2.3', '>=1.0.0,<2.0.0'), true);
  assert.equal(satisfiesVersion('2.0.0', '>=1.0.0,<2.0.0'), false);
  assert.equal(satisfiesVersion('1.0.0-beta', '>=1.0.0'), false);
  for (const version of ['>>1', '=>1', '^1', '~1', 'latest', '>=1 || <3']) assert.throws(() => parseRuntimeManifest(Buffer.from(JSON.stringify({ ...manifest, dependencies: { python: [{ name: 'test', version }] } }))));
});
test('disabled execution and missing entrypoints are not reported ready', async () => {
  const checker = createReadinessChecker({ environment: () => ({ fingerprint: 'off', enabled: true, scriptEnabled: false, publicNetwork: false }), probe: async () => { assert.fail('must not launch probe'); } });
  const report = await checker.check({ ...baseInput, files: [{ path: 'scripts/another.py', hash: 'a' }] });
  assert.equal(report.status, 'blocked'); assert.equal(report.items.length, 2);
});
test('instruction-only manifests still enforce declared tools; entrypoints must match supported interpreters', async () => {
  const checker = createReadinessChecker({ environment: () => ({ fingerprint: 'image', enabled: true, scriptEnabled: true, publicNetwork: false }), probe: async () => [] });
  assert.equal((await checker.check({ ...baseInput, files: [], runtime: { ...manifest, entrypoints: [], requiredTools: ['missing'] } })).status, 'blocked');
  for (const [path, runtimes] of [['scripts/main.py', ['node']], ['scripts/main.ts', ['node']]] as const) {
    assert.equal((await checker.check({ ...baseInput, files: [{ path, hash: 'a' }], runtime: { ...manifest, entrypoints: [path], runtimes } as any })).status, 'blocked');
  }
});
