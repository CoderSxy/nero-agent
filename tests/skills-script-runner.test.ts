/**
 * Task 6: SkillScriptRunner — permissions, argv, limits, cleanup, runtime report, tool gate.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authContextFromUser } from '../src/mastra/auth/auth-context.ts';
import type { AuthUser } from '../src/mastra/auth/service.ts';
import type { DockerEngine, DockerInspect } from '../src/mastra/sandbox/docker/client.ts';
import type { DockerCreateOptions } from '../src/mastra/sandbox/docker/config.ts';
import { commandQueue } from '../src/mastra/sandbox/execution-queue.ts';
import {
  SandboxCleaner,
  cleanupOrphanSkillScriptContainers,
} from '../src/mastra/sandbox/cleaner.ts';
import { SandboxRegistry } from '../src/mastra/sandbox/registry.ts';
import { FakeSandboxProvider } from '../src/mastra/sandbox/fake-provider.ts';
import { sandboxIdFor } from '../src/mastra/sandbox/types.ts';
import { isSkillScriptExecutionEnabled } from '../src/mastra/skills/config.ts';
import { createSkillTools } from '../src/mastra/skills/tools.ts';
import { reportSkillRuntimeCompatibility } from '../src/mastra/skills/runtime.ts';
import {
  createSkillScriptRunner,
  type SkillScriptRunnerDeps,
} from '../src/mastra/skills/script-runner.ts';
import { SKILL_SCRIPT_RUN_LABEL } from '../src/mastra/skills/script-container.ts';
import type {
  SkillExecutionContext,
  SkillPin,
  SkillResult,
  SkillRuntimeManifest,
} from '../src/mastra/skills/types.ts';

// These cases use FakeEngine and fixture UUIDs. A process-wide DATABASE_URL
// (from --env-file) would insert those ids into app_workspaces / app_sandbox_instances.
delete process.env.DATABASE_URL;

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const THREAD = 'thread-skill-script';
const SKILL_ID = '33333333-3333-4333-8333-333333333333';
const MANIFEST = 'a'.repeat(64);
const IMAGE = `nero-sandbox@sha256:${'b'.repeat(64)}`;

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

function ctx(pins = new Map<string, SkillPin>()): SkillExecutionContext {
  return {
    serverExecutionId: randomUUID(),
    auth: authContextFromUser(user(USER)),
    threadId: THREAD,
    pins,
  };
}

function lookup(owner = USER) {
  return {
    getThreadById: async ({ threadId }: { threadId: string }) => {
      if (threadId === THREAD) return { id: threadId, resourceId: owner };
      return null;
    },
  };
}

function manifest(partial: Partial<SkillRuntimeManifest> = {}): SkillRuntimeManifest {
  return {
    schemaVersion: 1,
    runtimes: ['python3'],
    entrypoints: ['scripts/main.py'],
    requiredTools: [],
    network: 'none',
    ...partial,
  };
}

type FakeEngine = DockerEngine & {
  created: DockerCreateOptions[];
  removed: string[];
  removeFailuresLeft: number;
  execImpl: DockerEngine['exec'];
};

function fakeEngine(overrides: Partial<FakeEngine> = {}): FakeEngine {
  const containers = new Map<string, DockerCreateOptions>();
  let seq = 0;
  const engine: FakeEngine = {
    created: [],
    removed: [],
    removeFailuresLeft: 0,
    execImpl: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    async create(options) {
      engine.created.push(options);
      const id = `c${++seq}`;
      containers.set(id, options);
      return { id };
    },
    async start() {},
    async inspect(id) {
      const options = containers.get(id);
      if (!options) return null;
      return {
        Id: id,
        State: { Running: true, Status: 'running' },
        Config: { Labels: options.Labels, User: options.User },
        HostConfig: options.HostConfig,
      } satisfies DockerInspect;
    },
    async findLabeled(label, value) {
      const out: DockerInspect[] = [];
      for (const [id, options] of containers) {
        if (options.Labels?.[label] === value) {
          out.push((await engine.inspect(id))!);
        }
      }
      return out;
    },
    async exec(id, command, args, options) {
      return engine.execImpl(id, command, args, options);
    },
    async stop() {},
    async remove(id) {
      if (engine.removeFailuresLeft > 0) {
        engine.removeFailuresLeft -= 1;
        throw new Error('remove failed');
      }
      engine.removed.push(id);
      containers.delete(id);
    },
    ...overrides,
  };
  return engine;
}

async function setupWorkspaceAndRelease() {
  const workspaceBase = await mkdtemp(join(tmpdir(), 'skill-run-ws-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'skill-run-store-'));
  process.env.WORKSPACE_ROOT = workspaceBase;
  process.env.SKILLS_STORAGE_ROOT = storageRoot;
  process.env.SANDBOX_IMAGE = IMAGE;
  process.env.SANDBOX_COMMANDS_ENABLED = 'true';
  process.env.SANDBOX_FILE_WRITE_ENABLED = 'true';
  process.env.WORKSPACE_HOST_QUOTA_VERIFIED = 'true';
  process.env.SANDBOX_PROVIDER = 'docker';
  process.env.AGENT_SKILLS_ENABLED = 'true';
  process.env.SKILL_SCRIPT_EXECUTION_ENABLED = 'true';

  const workspaceRoot = join(workspaceBase, 'users', USER, 'workspace');
  const releaseRoot = join(storageRoot, 'releases', SKILL_ID, '1', MANIFEST);
  await mkdir(join(workspaceRoot, 'threads', THREAD), { recursive: true });
  await mkdir(join(releaseRoot, 'scripts'), { recursive: true });
  await writeFile(join(releaseRoot, 'scripts', 'main.py'), 'print(1)\n');
  await writeFile(join(releaseRoot, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n\nbody\n');
  return { workspaceRoot, releaseRoot, storageRoot };
}

function pin(): SkillPin {
  return {
    skillId: SKILL_ID,
    name: 'demo-skill',
    version: 1,
    manifestHash: MANIFEST,
  };
}

function resolveOk(releaseRoot: string, runtime = manifest()): SkillScriptRunnerDeps['resolve'] {
  return async () => ({
    ok: true,
    skill: pin(),
    data: {
      pin: pin(),
      releaseRoot,
      runtimeManifest: runtime,
    },
  });
}

function makeRunner(
  engine: FakeEngine,
  releaseRoot: string,
  resolve: SkillScriptRunnerDeps['resolve'] = resolveOk(releaseRoot),
) {
  return createSkillScriptRunner({
    engine,
    lookup: lookup(),
    resolve,
    imageDigest: IMAGE,
    queue: commandQueue,
  });
}

test('runtime report: missing requiredTools → missing-tools; requests/curl → network-unavailable', () => {
  assert.equal(
    reportSkillRuntimeCompatibility(manifest({
      network: 'server-tools',
      requiredTools: ['web_search', 'missing_tool_xyz'],
    }), { registeredToolIds: ['web_search', 'skill', 'execute_command'] }),
    'missing-tools',
  );
  assert.equal(
    reportSkillRuntimeCompatibility(manifest({
      network: 'none',
      entrypoints: ['scripts/fetch.py'],
    }), {
      registeredToolIds: ['web_search'],
      scriptTexts: {
        'scripts/fetch.py': 'import requests\nrequests.get("https://example.com")\n',
      },
    }),
    'network-unavailable',
  );
  assert.equal(
    reportSkillRuntimeCompatibility(manifest({
      network: 'none',
      entrypoints: ['scripts/main.py'],
    }), {
      registeredToolIds: [],
      scriptTexts: { 'scripts/main.py': 'print("hi")\n' },
    }),
    'ready',
  );
});

test('script runner: missing permission / revoked → SKILL_UNAVAILABLE', async () => {
  const { releaseRoot } = await setupWorkspaceAndRelease();
  const engine = fakeEngine();
  const runner = makeRunner(engine, releaseRoot, async () => ({
    ok: false,
    code: 'SKILL_UNAVAILABLE',
    message: 'Skill is unavailable',
  }));
  const result = await runner.execute(ctx(), { skillName: 'demo-skill', path: 'scripts/main.py' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'SKILL_UNAVAILABLE');
  assert.equal(engine.created.length, 0);
});

test('script runner: no entrypoint / path outside scripts / absolute path / shell args / arg limits', async () => {
  const { releaseRoot } = await setupWorkspaceAndRelease();
  const engine = fakeEngine();
  const runner = makeRunner(engine, releaseRoot, resolveOk(releaseRoot, manifest({
    entrypoints: ['scripts/main.py'],
  })));

  const noEntry = await runner.execute(ctx(), { skillName: 'demo-skill', path: 'scripts/other.py' });
  assert.equal(noEntry.ok, false);
  if (!noEntry.ok) assert.equal(noEntry.code, 'SCRIPT_NOT_ALLOWED');

  const abs = await runner.execute(ctx(), { skillName: 'demo-skill', path: '/tmp/evil.py' });
  assert.equal(abs.ok, false);
  if (!abs.ok) assert.equal(abs.code, 'SCRIPT_NOT_ALLOWED');

  const shell = await runner.execute(ctx(), {
    skillName: 'demo-skill',
    path: 'scripts/main.py',
    args: ['ok; rm -rf /'],
  });
  assert.equal(shell.ok, false);
  if (!shell.ok) assert.equal(shell.code, 'SCRIPT_NOT_ALLOWED');

  const tooMany = await runner.execute(ctx(), {
    skillName: 'demo-skill',
    path: 'scripts/main.py',
    args: Array.from({ length: 65 }, (_, i) => `a${i}`),
  });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.equal(tooMany.code, 'SCRIPT_NOT_ALLOWED');

  const huge = await runner.execute(ctx(), {
    skillName: 'demo-skill',
    path: 'scripts/main.py',
    args: [ 'x'.repeat(17 * 1024) ],
  });
  assert.equal(huge.ok, false);
  if (!huge.ok) assert.equal(huge.code, 'SCRIPT_NOT_ALLOWED');

  assert.equal(engine.created.length, 0);
});

test('script runner: exec uses interpreter argv (not shell -c); destroys container after', async () => {
  const { releaseRoot } = await setupWorkspaceAndRelease();
  const engine = fakeEngine();
  let seenCmd = '';
  let seenArgs: string[] = [];
  engine.execImpl = async (_id, command, args) => {
    seenCmd = command;
    seenArgs = args;
    return { exitCode: 0, stdout: 'done', stderr: '' };
  };
  const runner = makeRunner(engine, releaseRoot);
  const result = await runner.execute(ctx(), {
    skillName: 'demo-skill',
    path: 'scripts/main.py',
    args: ['--flag', 'value'],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.exitCode, 0);
    assert.equal(result.data.stdout, 'done');
    assert.equal(result.data.timedOut, false);
    assert.ok(!JSON.stringify(result).includes(releaseRoot));
    assert.ok(!('hostPath' in (result.data as object)));
  }
  assert.equal(seenCmd, 'python3');
  assert.deepEqual(seenArgs, ['/skill/scripts/main.py', '--flag', 'value']);
  assert.ok(!seenArgs.some(a => a.includes('sh') || a.includes('-c')));
  assert.equal(engine.created.length, 1);
  assert.equal(engine.created[0]!.Labels?.[SKILL_SCRIPT_RUN_LABEL], '1');
  assert.equal(engine.removed.length, 1);
});

test('script runner: cancel / timeout / stdout stderr truncate / non-zero exit / cleanup retry', async () => {
  const { releaseRoot } = await setupWorkspaceAndRelease();

  // abort
  {
    const engine = fakeEngine();
    const runner = makeRunner(engine, releaseRoot);
    const ac = new AbortController();
    ac.abort();
    const result = await runner.execute(
      ctx(),
      { skillName: 'demo-skill', path: 'scripts/main.py' },
      ac.signal,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'ABORTED');
  }

  // timeout
  {
    const engine = fakeEngine();
    engine.execImpl = async () => ({ exitCode: 124, stdout: '', stderr: 'timed out', timedOut: true });
    const shortRunner = createSkillScriptRunner({
      engine,
      lookup: lookup(),
      resolve: resolveOk(releaseRoot),
      imageDigest: IMAGE,
      queue: commandQueue,
      timeoutMs: 1,
    });
    engine.execImpl = async () => ({ exitCode: 124, stdout: '', stderr: '', timedOut: true });
    const result = await shortRunner.execute(ctx(), { skillName: 'demo-skill', path: 'scripts/main.py' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.timedOut, true);
    }
    assert.equal(engine.removed.length, 1);
  }

  // truncate
  {
    const engine = fakeEngine();
    const big = 'Z'.repeat(70 * 1024);
    engine.execImpl = async () => ({ exitCode: 0, stdout: big, stderr: big });
    const runner = makeRunner(engine, releaseRoot);
    const result = await runner.execute(ctx(), { skillName: 'demo-skill', path: 'scripts/main.py' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.truncated, true);
      assert.ok(Buffer.byteLength(result.data.stdout, 'utf8') <= 64 * 1024);
      assert.ok(Buffer.byteLength(result.data.stderr, 'utf8') <= 64 * 1024);
    }
  }

  // non-zero
  {
    const engine = fakeEngine();
    engine.execImpl = async () => ({ exitCode: 2, stdout: '', stderr: 'boom' });
    const runner = makeRunner(engine, releaseRoot);
    const result = await runner.execute(ctx(), { skillName: 'demo-skill', path: 'scripts/main.py' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.exitCode, 2);
      assert.equal(result.data.stderr, 'boom');
    }
  }

  // cleanup retry
  {
    const engine = fakeEngine();
    engine.removeFailuresLeft = 1;
    const runner = makeRunner(engine, releaseRoot);
    const result = await runner.execute(ctx(), { skillName: 'demo-skill', path: 'scripts/main.py' });
    assert.equal(result.ok, true);
    assert.equal(engine.removed.length, 1);
  }
});

test('script runner refuses when sandbox/script switches are off', async () => {
  const { releaseRoot } = await setupWorkspaceAndRelease();
  delete process.env.SKILL_SCRIPT_EXECUTION_ENABLED;
  const engine = fakeEngine();
  const runner = makeRunner(engine, releaseRoot);
  const result = await runner.execute(ctx(), { skillName: 'demo-skill', path: 'scripts/main.py' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'RUNTIME_UNAVAILABLE');
  assert.equal(engine.created.length, 0);
});

test('run_skill_script tool exposed only when skills + script + sandbox switches are all on', () => {
  process.env.AGENT_SKILLS_ENABLED = 'true';
  process.env.SKILL_SCRIPT_EXECUTION_ENABLED = 'true';
  process.env.SANDBOX_COMMANDS_ENABLED = 'true';
  process.env.SANDBOX_PROVIDER = 'docker';
  process.env.WORKSPACE_HOST_QUOTA_VERIFIED = 'true';
  process.env.SANDBOX_FILE_WRITE_ENABLED = 'true';
  assert.equal(isSkillScriptExecutionEnabled(), true);

  delete process.env.SKILL_SCRIPT_EXECUTION_ENABLED;
  assert.equal(isSkillScriptExecutionEnabled(), false);

  process.env.SKILL_SCRIPT_EXECUTION_ENABLED = 'true';
  delete process.env.SANDBOX_COMMANDS_ENABLED;
  assert.equal(isSkillScriptExecutionEnabled(), false);

  // createSkillTools without runner still returns skill tools; run_skill_script needs runner deps
  process.env.AGENT_SKILLS_ENABLED = 'true';
  process.env.SKILL_SCRIPT_EXECUTION_ENABLED = 'true';
  process.env.SANDBOX_COMMANDS_ENABLED = 'true';
  process.env.SANDBOX_PROVIDER = 'docker';
  process.env.WORKSPACE_HOST_QUOTA_VERIFIED = 'true';
  process.env.SANDBOX_FILE_WRITE_ENABLED = 'true';
  const toolsWithout = createSkillTools({
    service: {} as never,
    repository: {} as never,
  });
  assert.ok(!('run_skill_script' in toolsWithout));

  const toolsWith = createSkillTools({
    service: {} as never,
    repository: {} as never,
    scriptRunner: {
      execute: async (): Promise<SkillResult<never>> => ({
        ok: false,
        code: 'RUNTIME_UNAVAILABLE',
        message: 'stub',
      }),
    },
  });
  assert.ok('run_skill_script' in toolsWith);
});

test('orphan skill-run cleaner removes labeled skill containers without touching user sandboxes', async () => {
  const engine = fakeEngine();
  const skillOpts: DockerCreateOptions = {
    Image: IMAGE,
    User: '10001:10001',
    Labels: { [SKILL_SCRIPT_RUN_LABEL]: '1' },
    HostConfig: { NetworkMode: 'none' },
  };
  const { id: skillId } = await engine.create(skillOpts);
  const sandboxOpts: DockerCreateOptions = {
    Image: IMAGE,
    User: '10001:10001',
    Labels: { 'nero.sandbox': '1', 'nero.sandbox.user': USER },
    HostConfig: { NetworkMode: 'none' },
  };
  const { id: sandboxId } = await engine.create(sandboxOpts);

  const report = await cleanupOrphanSkillScriptContainers(engine, {
    now: Date.now(),
    maxAgeMs: 0,
  });
  assert.ok(report.removed.includes(skillId));
  assert.ok(!report.removed.includes(sandboxId));
  assert.equal((await engine.inspect(sandboxId))?.Id, sandboxId);

  // Existing SandboxCleaner path still only operates on registry owners
  const registry = new SandboxRegistry();
  const provider = new FakeSandboxProvider();
  const owner = { userId: USER, sandboxId: sandboxIdFor(USER) };
  await registry.upsert({
    userId: USER,
    sandboxId: owner.sandboxId,
    containerId: sandboxId,
    status: 'running',
    lastActiveAt: Date.now(),
  });
  const cleaner = new SandboxCleaner(provider, registry, async () => [owner], () => false);
  const idle = await cleaner.runOnce(Date.now());
  assert.deepEqual(idle.stopped, []);
});
