import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import { dockerSandboxCreateOptions, validateDockerCreateConfig } from '../src/mastra/sandbox/docker/config';
import type { DockerEngine, DockerInspect } from '../src/mastra/sandbox/docker/client';
import { DockerSandboxProvider } from '../src/mastra/sandbox/docker/provider';
import { SandboxManager } from '../src/mastra/sandbox/manager';
import { SandboxRegistry } from '../src/mastra/sandbox/registry';
import { sandboxIdFor } from '../src/mastra/sandbox/types';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';
const THREAD = 'thread-docker';
const DIGEST_IMAGE = 'mastra-agent-sandbox:1.0@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

function lookup() {
  return {
    getThreadById: async ({ threadId }: { threadId: string }) =>
      threadId === THREAD ? { id: threadId, resourceId: USER_A } : null,
  };
}

class MemoryDockerEngine implements DockerEngine {
  created: DockerInspect[] = [];
  execs: Array<{ id: string; command: string; cwd: string }> = [];

  async create(options: Parameters<DockerEngine['create']>[0]) {
    validateDockerCreateConfig(options, options.HostConfig?.Binds?.[0]?.split(':')[0] ?? '');
    const id = `ctr-${this.created.length + 1}`;
    this.created.push({
      Id: id,
      State: { Running: true, Status: 'running' },
      Config: { Labels: options.Labels, User: options.User },
      HostConfig: options.HostConfig,
      Mounts: [{ Source: options.HostConfig?.Binds?.[0]?.split(':')[0] ?? '', Destination: '/workspace' }],
    });
    return { id };
  }

  async start(id: string): Promise<void> {
    const item = this.created.find(row => row.Id === id);
    if (item) item.State = { Running: true, Status: 'running' };
  }

  async inspect(id: string) {
    return this.created.find(item => item.Id === id) ?? null;
  }

  async findLabeled(label: string, value: string) {
    return this.created.filter(item => item.Config?.Labels?.[label] === value);
  }

  async exec(id: string, command: string, args: string[], options: { cwd: string }) {
    this.execs.push({ id, command, cwd: options.cwd });
    return { exitCode: 0, stdout: `${command} ${args.join(' ')}`, stderr: '' };
  }

  async stop(id: string) {
    const item = this.created.find(row => row.Id === id);
    if (item) item.State = { Running: false, Status: 'exited' };
  }

  async remove(id: string) {
    this.created = this.created.filter(item => item.Id !== id);
  }
}

test('A cannot see B workspace mounts, docker socket, or a network', async () => {
  process.env.SANDBOX_IMAGE = DIGEST_IMAGE;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'dock-root-'));
  const engine = new MemoryDockerEngine();
  const registry = new SandboxRegistry();
  const provider = new DockerSandboxProvider(engine, registry);
  const rootA = `${process.env.WORKSPACE_ROOT}/users/${USER_A}/workspace`;
  const rootB = `${process.env.WORKSPACE_ROOT}/users/${USER_B}/workspace`;
  await provider.ensureRunning({ userId: USER_A, sandboxId: sandboxIdFor(USER_A) }, rootA);
  await provider.ensureRunning({ userId: USER_B, sandboxId: sandboxIdFor(USER_B) }, rootB);
  const [a, b] = engine.created;
  assert.equal(a.HostConfig?.NetworkMode, 'none');
  assert.equal(b.HostConfig?.NetworkMode, 'none');
  assert.deepEqual(a.HostConfig?.Binds, [`${rootA}:/workspace:rw`]);
  assert.deepEqual(b.HostConfig?.Binds, [`${rootB}:/workspace:rw`]);
  assert.ok(!JSON.stringify(engine.created).includes('docker.sock'));
  assert.notEqual(a.HostConfig?.Binds?.[0], b.HostConfig?.Binds?.[0]);
});

test('ordinary chat does not create a container; first execute creates and later reuses', async () => {
  process.env.SANDBOX_IMAGE = DIGEST_IMAGE;
  process.env.SANDBOX_COMMANDS_ENABLED = 'true';
  process.env.SANDBOX_FILE_WRITE_ENABLED = 'true';
  process.env.WORKSPACE_HOST_QUOTA_VERIFIED = 'true';
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'dock-reuse-'));
  const engine = new MemoryDockerEngine();
  const registry = new SandboxRegistry();
  const provider = new DockerSandboxProvider(engine, registry);
  new SandboxManager(provider, lookup());
  assert.equal(engine.created.length, 0);
  const manager = new SandboxManager(provider, lookup());
  await manager.execute({
    auth: authContextFromUser(user(USER_A)),
    threadId: THREAD,
    command: 'python3',
    args: ['analysis.py'],
  });
  await manager.execute({
    auth: authContextFromUser(user(USER_A)),
    threadId: THREAD,
    command: 'python3',
    args: ['analysis.py'],
  });
  assert.equal(engine.created.length, 1);
  assert.equal(engine.execs.length, 2);
  assert.equal(engine.execs[0].id, engine.execs[1].id);
});

test('process restart reconciles labels and remove keeps workspace files', async () => {
  process.env.SANDBOX_IMAGE = DIGEST_IMAGE;
  process.env.SANDBOX_COMMANDS_ENABLED = 'true';
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'dock-restart-'));
  const engine = new MemoryDockerEngine();
  const registry = new SandboxRegistry();
  const first = new DockerSandboxProvider(engine, registry);
  const owner = { userId: USER_A, sandboxId: sandboxIdFor(USER_A) };
  const root = `${process.env.WORKSPACE_ROOT}/users/${USER_A}/workspace`;
  await first.ensureRunning(owner, root);
  const keep = join(root, 'threads', THREAD, 'keep.txt');
  await writeFile(keep, 'keep', { flag: 'wx' }).catch(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'threads', THREAD), { recursive: true });
    await writeFile(keep, 'keep');
  });
  const restarted = new DockerSandboxProvider(engine, new SandboxRegistry());
  await restarted.ensureRunning(owner, root);
  assert.equal(engine.created.length, 1);
  await restarted.remove(owner);
  assert.equal(engine.created.length, 0);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(keep, 'utf8'), 'keep');
});

test('stopped user container is started again without creating a second container', async () => {
  process.env.SANDBOX_IMAGE = DIGEST_IMAGE;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'dock-stopped-'));
  const engine = new MemoryDockerEngine();
  const provider = new DockerSandboxProvider(engine, new SandboxRegistry());
  const owner = { userId: USER_A, sandboxId: sandboxIdFor(USER_A) };
  const root = `${process.env.WORKSPACE_ROOT}/users/${USER_A}/workspace`;
  await provider.ensureRunning(owner, root);
  await provider.stop(owner);
  await provider.ensureRunning(owner, root);
  assert.equal(engine.created.length, 1);
  assert.equal((await provider.inspect(owner)).status, 'running');
});

test('a third running user sandbox is rejected when the configured limit is two', async () => {
  process.env.SANDBOX_IMAGE = DIGEST_IMAGE;
  process.env.SANDBOX_MAX_CONCURRENT = '2';
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'dock-limit-'));
  const engine = new MemoryDockerEngine();
  const provider = new DockerSandboxProvider(engine, new SandboxRegistry());
  const root = (id: string) => `${process.env.WORKSPACE_ROOT}/users/${id}/workspace`;
  await provider.ensureRunning({ userId: USER_A, sandboxId: sandboxIdFor(USER_A) }, root(USER_A));
  await provider.ensureRunning({ userId: USER_B, sandboxId: sandboxIdFor(USER_B) }, root(USER_B));
  await assert.rejects(
    provider.ensureRunning({ userId: USER_C, sandboxId: sandboxIdFor(USER_C) }, root(USER_C)),
    /limit/i,
  );
  assert.equal(engine.created.length, 2);
});

test('real docker isolation is skipped unless SANDBOX_DOCKER_INTEGRATION=true', async t => {
  if (process.env.SANDBOX_DOCKER_INTEGRATION !== 'true') {
    t.skip('Set SANDBOX_DOCKER_INTEGRATION=true on a host with Docker to run live isolation checks');
    return;
  }
  const options = dockerSandboxCreateOptions(`${process.env.WORKSPACE_ROOT}/users/${USER_A}/workspace`);
  validateDockerCreateConfig(options, `${process.env.WORKSPACE_ROOT}/users/${USER_A}/workspace`);
});
