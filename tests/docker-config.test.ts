import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import {
  assertSandboxImage,
  dockerSandboxCreateOptions,
  validateDockerCreateConfig,
} from '../src/mastra/sandbox/docker/config';

const WORKSPACE = '/data/mastra/users/11111111-1111-4111-8111-111111111111/workspace';
const DIGEST_IMAGE = 'mastra-agent-sandbox:1.0@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('docker create options lock down the user container', () => {
  process.env.WORKSPACE_ROOT = '/data/mastra';
  process.env.SANDBOX_IMAGE = DIGEST_IMAGE;
  const options = dockerSandboxCreateOptions(WORKSPACE);
  assert.equal(options.User, '10001:10001');
  assert.equal(options.HostConfig?.ReadonlyRootfs, true);
  assert.equal(options.HostConfig?.NetworkMode, 'none');
  assert.equal(options.HostConfig?.Privileged, false);
  assert.notEqual(options.HostConfig?.PidMode, 'host');
  assert.notEqual(options.HostConfig?.NetworkMode, 'host');
  assert.ok(options.HostConfig?.CapDrop?.includes('ALL'));
  assert.equal(options.HostConfig?.PidsLimit, 128);
  assert.equal(options.HostConfig?.Memory, 384 * 1024 * 1024);
  assert.ok((options.HostConfig?.MemorySwap ?? 0) <= (options.HostConfig?.Memory ?? 0));
  assert.equal(options.HostConfig?.NanoCpus, 500_000_000);
  assert.equal(options.HostConfig?.Tmpfs?.['/tmp'], 'rw,noexec,nosuid,size=256m');
  assert.deepEqual(options.HostConfig?.Binds, [`${WORKSPACE}:/workspace:rw`]);
  const serialized = JSON.stringify(options);
  assert.ok(!serialized.includes('/var/run/docker.sock'));
  validateDockerCreateConfig(options, WORKSPACE);
});

test('invalid sandbox image or unsafe binds fail closed', () => {
  process.env.WORKSPACE_ROOT = '/data/mastra';
  process.env.SANDBOX_IMAGE = 'mastra-agent-sandbox:1.0';
  assert.throws(() => assertSandboxImage());
  process.env.SANDBOX_IMAGE = DIGEST_IMAGE;
  const unsafe = dockerSandboxCreateOptions(WORKSPACE);
  unsafe.HostConfig = {
    ...unsafe.HostConfig,
    Privileged: true,
    Binds: [`${WORKSPACE}:/workspace:rw`, '/var/run/docker.sock:/var/run/docker.sock'],
  };
  assert.throws(() => validateDockerCreateConfig(unsafe, WORKSPACE));
  assert.throws(() => dockerSandboxCreateOptions(join(WORKSPACE, '..', 'other')));
});
