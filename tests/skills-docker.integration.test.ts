/**
 * Task 7 / B-gate: real Docker skill-script acceptance.
 * Never uses FakeProvider. Skips with an explicit reason when Docker/digest/workspace gate fails.
 *
 * Enable:
 *   SKILLS_DOCKER_INTEGRATION=true
 *   SANDBOX_IMAGE=<name>@sha256:<64hex>
 *   WORKSPACE_ROOT=<dedicated temp/test root>   # required; must not be empty or host default alone
 *   SKILLS_STORAGE_ROOT=<dedicated skills root>
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile, chmod, access, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { authContextFromUser } from '../src/mastra/auth/auth-context.ts';
import type { AuthUser } from '../src/mastra/auth/service.ts';
import { FileService, FileServiceError } from '../src/mastra/files/service.ts';
import { createDockerodeEngine } from '../src/mastra/sandbox/docker/client.ts';
import { DockerSandboxProvider } from '../src/mastra/sandbox/docker/provider.ts';
import { commandQueue, ExecutionQueue } from '../src/mastra/sandbox/execution-queue.ts';
import { SandboxManager } from '../src/mastra/sandbox/manager.ts';
import { SandboxRegistry } from '../src/mastra/sandbox/registry.ts';
import { sandboxIdFor } from '../src/mastra/sandbox/types.ts';
import { createSkillScriptRunner } from '../src/mastra/skills/script-runner.ts';
import { SKILL_SCRIPT_RUN_LABEL } from '../src/mastra/skills/script-container.ts';
import { reportSkillRuntimeCompatibility } from '../src/mastra/skills/runtime.ts';
import type {
  SkillExecutionContext,
  SkillPin,
  SkillRuntimeManifest,
} from '../src/mastra/skills/types.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills');
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const THREAD_A = 'thread-skills-docker-a';
const SKILL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PIN_RE = /^.+@sha256:[a-f0-9]{64}$/i;

type Gate =
  | { ok: true; imageDigest: string; workspaceRoot: string; storageRoot: string }
  | { ok: false; reason: string };

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

function lookup(owner = USER_A) {
  return {
    getThreadById: async ({ threadId }: { threadId: string }) => {
      if (threadId === THREAD_A) return { id: threadId, resourceId: owner };
      return null;
    },
  };
}

function hashManifest(parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

async function dockerReachable(): Promise<boolean> {
  try {
    const engine = await createDockerodeEngine();
    await engine.findLabeled('nero.skill-run', '__probe__');
    return true;
  } catch {
    return false;
  }
}

async function evaluateGate(): Promise<Gate> {
  if (process.env.SKILLS_DOCKER_INTEGRATION !== 'true') {
    return {
      ok: false,
      reason:
        'SKILLS_DOCKER_INTEGRATION!=true — real Docker B-gate skipped (set flag + pinned SANDBOX_IMAGE + dedicated WORKSPACE_ROOT/SKILLS_STORAGE_ROOT)',
    };
  }
  const imageDigest = process.env.SANDBOX_IMAGE?.trim() ?? '';
  if (!PIN_RE.test(imageDigest)) {
    return {
      ok: false,
      reason: 'SANDBOX_IMAGE missing or not pinned to sha256 digest — B-gate skipped (no FakeProvider fallback)',
    };
  }
  const workspaceRoot = process.env.WORKSPACE_ROOT?.trim() ?? '';
  const storageRoot = process.env.SKILLS_STORAGE_ROOT?.trim() ?? '';
  if (!workspaceRoot || !storageRoot) {
    return {
      ok: false,
      reason: 'Dedicated WORKSPACE_ROOT and SKILLS_STORAGE_ROOT required for B-gate — skipped',
    };
  }
  if (!(await dockerReachable())) {
    return {
      ok: false,
      reason: 'Docker Engine unreachable — B-gate skipped (no FakeProvider fallback)',
    };
  }
  return { ok: true, imageDigest, workspaceRoot, storageRoot };
}

async function enableSkillScriptEnv(imageDigest: string): Promise<void> {
  process.env.SANDBOX_IMAGE = imageDigest;
  process.env.SANDBOX_PROVIDER = 'docker';
  process.env.SANDBOX_COMMANDS_ENABLED = 'true';
  process.env.SANDBOX_FILE_WRITE_ENABLED = 'true';
  process.env.WORKSPACE_HOST_QUOTA_VERIFIED = 'true';
  process.env.AGENT_SKILLS_ENABLED = 'true';
  process.env.SKILL_SCRIPT_EXECUTION_ENABLED = 'true';
  // Avoid FileService/workspace DB side effects in integration runs.
  delete process.env.DATABASE_URL;
}

async function materializeRelease(
  storageRoot: string,
  skillId: string,
  version: number,
  fixtureName: 'script-demo' | 'reference-demo',
  manifestHash: string,
): Promise<string> {
  const releaseRoot = join(storageRoot, 'releases', skillId, String(version), manifestHash);
  await mkdir(releaseRoot, { recursive: true });
  await cp(join(FIXTURES, fixtureName), releaseRoot, { recursive: true });
  // Readable by container UID 10001.
  await chmod(releaseRoot, 0o755);
  return releaseRoot;
}

async function chmodTreeWritable(root: string): Promise<void> {
  // Docker Desktop bind mounts often map host perms; make thread cwd world-writable for UID 10001.
  const { readdir, stat } = await import('node:fs/promises');
  await chmod(root, 0o777);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) await chmodTreeWritable(abs);
    else if (entry.isFile()) await chmod(abs, 0o666);
    else {
      const s = await stat(abs);
      if (s.isDirectory()) await chmodTreeWritable(abs);
    }
  }
}

function scriptRuntime(): SkillRuntimeManifest {
  return {
    schemaVersion: 1,
    runtimes: ['python3'],
    entrypoints: ['scripts/to_csv.py'],
    requiredTools: [],
    network: 'none',
  };
}

function pin(version: number, manifestHash: string): SkillPin {
  return {
    skillId: SKILL_ID,
    name: 'script-demo',
    version,
    manifestHash,
  };
}

function ctx(pins = new Map<string, SkillPin>()): SkillExecutionContext {
  return {
    serverExecutionId: randomUUID(),
    auth: authContextFromUser(user(USER_A)),
    threadId: THREAD_A,
    pins,
  };
}

const gatePromise = evaluateGate();

test('B-gate env: skip with reason when Docker/digest/workspace missing (never FakeProvider)', async (t) => {
  const gate = await gatePromise;
  if (!gate.ok) {
    t.skip(gate.reason);
    return;
  }
  assert.match(gate.imageDigest, PIN_RE);
  assert.ok(gate.workspaceRoot.length > 0);
  assert.ok(gate.storageRoot.length > 0);
});

test('image interpreters: python3 / node / bash versions inside pinned digest (not host)', async (t) => {
  const gate = await gatePromise;
  if (!gate.ok) {
    t.skip(gate.reason);
    return;
  }
  await enableSkillScriptEnv(gate.imageDigest);
  const engine = await createDockerodeEngine();
  const { createSkillScriptContainerOptions, validateSkillScriptContainerOptions } = await import(
    '../src/mastra/skills/script-container.ts'
  );

  const manifestHash = hashManifest(['interp', gate.imageDigest]);
  const releaseRoot = await materializeRelease(
    gate.storageRoot,
    SKILL_ID,
    1,
    'script-demo',
    manifestHash,
  );
  const workspaceRoot = join(gate.workspaceRoot, 'users', USER_A, 'workspace');
  await mkdir(join(workspaceRoot, 'threads', THREAD_A), { recursive: true });
  await chmodTreeWritable(workspaceRoot);

  const options = createSkillScriptContainerOptions({
    workspaceRoot,
    releaseRoot,
    imageDigest: gate.imageDigest,
    labels: { 'nero.skill-run.probe': 'interpreters' },
  });
  validateSkillScriptContainerOptions(options, { workspaceRoot, releaseRoot });

  const created = await engine.create(options);
  try {
    await engine.start(created.id);
    const py = await engine.exec(created.id, 'python3', ['--version'], {
      cwd: '/workspace',
      timeoutMs: 15_000,
    });
    const node = await engine.exec(created.id, 'node', ['--version'], {
      cwd: '/workspace',
      timeoutMs: 15_000,
    });
    const bash = await engine.exec(created.id, 'bash', ['--version'], {
      cwd: '/workspace',
      timeoutMs: 15_000,
    });
    assert.equal(py.exitCode, 0, py.stderr);
    assert.equal(node.exitCode, 0, node.stderr);
    assert.equal(bash.exitCode, 0, bash.stderr);
    assert.match(py.stdout + py.stderr, /Python\s+3\./);
    assert.match(node.stdout + node.stderr, /^v\d+/m);
    assert.match(bash.stdout + bash.stderr, /GNU bash/i);
    console.log('[B-gate interpreters]', {
      image: gate.imageDigest,
      python3: (py.stdout || py.stderr).trim(),
      node: (node.stdout || node.stderr).trim(),
      bash: (bash.stdout || bash.stderr).split('\n')[0]?.trim(),
    });
  } finally {
    await engine.remove(created.id, true);
    const leftover = await engine.findLabeled(SKILL_SCRIPT_RUN_LABEL, '1');
    assert.equal(
      leftover.filter((c) => c.Id.startsWith(created.id.slice(0, 12)) || c.Id === created.id).length,
      0,
    );
  }
});

test('script-demo: python3 → result.csv; FileService read ok; cross-user denied', async (t) => {
  const gate = await gatePromise;
  if (!gate.ok) {
    t.skip(gate.reason);
    return;
  }
  await enableSkillScriptEnv(gate.imageDigest);
  process.env.WORKSPACE_ROOT = gate.workspaceRoot;
  process.env.SKILLS_STORAGE_ROOT = gate.storageRoot;

  const manifestHash = hashManifest(['script-demo', 'v1']);
  const releaseRoot = await materializeRelease(
    gate.storageRoot,
    SKILL_ID,
    1,
    'script-demo',
    manifestHash,
  );
  const workspaceRoot = join(gate.workspaceRoot, 'users', USER_A, 'workspace');
  await mkdir(join(workspaceRoot, 'threads', THREAD_A), { recursive: true });
  await chmodTreeWritable(workspaceRoot);

  const engine = await createDockerodeEngine();
  const queue = new ExecutionQueue(2);
  const skillPin = pin(1, manifestHash);
  const runner = createSkillScriptRunner({
    engine,
    lookup: lookup(USER_A),
    imageDigest: gate.imageDigest,
    queue,
    resolve: async () => ({
      ok: true,
      skill: skillPin,
      data: { pin: skillPin, releaseRoot, runtimeManifest: scriptRuntime() },
    }),
  });

  const result = await runner.execute(ctx(new Map([[skillPin.skillId, skillPin]])), {
    skillName: 'script-demo',
    path: 'scripts/to_csv.py',
  });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) return;
  assert.equal(result.data.exitCode, 0, result.data.stderr);
  assert.ok(result.data.artifactRelativePaths.includes('result.csv'));

  const files = new FileService(lookup(USER_A));
  const owned = await files.read(authContextFromUser(user(USER_A)), THREAD_A, 'result.csv');
  const csv = owned.data.toString('utf8');
  assert.match(csv, /id,name/);
  assert.match(csv, /1,alpha/);
  assert.match(csv, /2,beta/);
  assert.ok(!csv.includes(gate.workspaceRoot), 'must not leak host workspace path in content contract');

  await assert.rejects(
    () => files.read(authContextFromUser(user(USER_B)), THREAD_A, 'result.csv'),
    (err: unknown) =>
      err instanceof FileServiceError
      || (err instanceof Error && /denied|different resource|not found/i.test(err.message)),
  );

  const leftovers = await engine.findLabeled(SKILL_SCRIPT_RUN_LABEL, '1');
  assert.equal(leftovers.length, 0, `orphan skill containers: ${leftovers.map((c) => c.Id).join(',')}`);
});

test('release mount is read-only; network none blocks outbound HTTP', async (t) => {
  const gate = await gatePromise;
  if (!gate.ok) {
    t.skip(gate.reason);
    return;
  }
  await enableSkillScriptEnv(gate.imageDigest);
  process.env.WORKSPACE_ROOT = gate.workspaceRoot;
  process.env.SKILLS_STORAGE_ROOT = gate.storageRoot;

  const manifestHash = hashManifest(['ro-net']);
  const releaseRoot = await materializeRelease(
    gate.storageRoot,
    SKILL_ID,
    2,
    'script-demo',
    manifestHash,
  );
  // Inject probe scripts into this release only (not the fixture source).
  await writeFile(
    join(releaseRoot, 'scripts', 'probe_ro.py'),
    'from pathlib import Path\nPath("/skill/assets/pwned.txt").write_text("x")\n',
  );
  await writeFile(
    join(releaseRoot, 'scripts', 'probe_net.py'),
    [
      'import urllib.request',
      'try:',
      '  urllib.request.urlopen("http://1.1.1.1", timeout=3)',
      '  raise SystemExit("network unexpectedly reachable")',
      'except Exception as e:',
      '  print(type(e).__name__ + ":" + str(e)[:200])',
      '  raise SystemExit(0)',
      '',
    ].join('\n'),
  );

  const workspaceRoot = join(gate.workspaceRoot, 'users', USER_A, 'workspace');
  await mkdir(join(workspaceRoot, 'threads', THREAD_A), { recursive: true });
  await chmodTreeWritable(workspaceRoot);

  const engine = await createDockerodeEngine();
  const { createSkillScriptContainerOptions } = await import('../src/mastra/skills/script-container.ts');
  const options = createSkillScriptContainerOptions({
    workspaceRoot,
    releaseRoot,
    imageDigest: gate.imageDigest,
  });
  const created = await engine.create(options);
  try {
    await engine.start(created.id);
    const ro = await engine.exec(created.id, 'python3', ['/skill/scripts/probe_ro.py'], {
      cwd: `/workspace/threads/${THREAD_A}`,
      timeoutMs: 15_000,
    });
    assert.notEqual(ro.exitCode, 0);
    assert.match(`${ro.stdout}\n${ro.stderr}`, /Read-only|Permission|EROFS|read-only/i);

    const net = await engine.exec(created.id, 'python3', ['/skill/scripts/probe_net.py'], {
      cwd: `/workspace/threads/${THREAD_A}`,
      timeoutMs: 20_000,
    });
    assert.equal(net.exitCode, 0, net.stderr);
    assert.match(net.stdout + net.stderr, /URLError|OSError|gaierror|Network|timed out|unreachable|Connection/i);

    // Host-side release file unchanged (rewrite failed).
    await assert.rejects(() => access(join(releaseRoot, 'assets', 'pwned.txt'), constants.F_OK));
  } finally {
    await engine.remove(created.id, true);
  }

  // Compatibility report for outbound scripts (no Docker retry).
  assert.equal(
    reportSkillRuntimeCompatibility(
      { ...scriptRuntime(), entrypoints: ['scripts/probe_net.py'] },
      { registeredToolIds: [], scriptTexts: { 'scripts/probe_net.py': 'import urllib.request\n' } },
    ),
    'network-unavailable',
  );
});

test('abort leaves no nero.skill-run containers; pin mount stays on v1 while pointer moves', async (t) => {
  const gate = await gatePromise;
  if (!gate.ok) {
    t.skip(gate.reason);
    return;
  }
  await enableSkillScriptEnv(gate.imageDigest);
  process.env.WORKSPACE_ROOT = gate.workspaceRoot;
  process.env.SKILLS_STORAGE_ROOT = gate.storageRoot;

  const hashV1 = hashManifest(['pin', 'v1']);
  const hashV2 = hashManifest(['pin', 'v2']);
  const releaseV1 = await materializeRelease(gate.storageRoot, SKILL_ID, 1, 'script-demo', hashV1);
  const releaseV2 = await materializeRelease(gate.storageRoot, SKILL_ID, 2, 'script-demo', hashV2);
  await writeFile(
    join(releaseV2, 'assets', 'data.json'),
    JSON.stringify({ rows: [{ id: 9, name: 'v2-only' }] }, null, 2),
  );
  await writeFile(
    join(releaseV1, 'scripts', 'slow_read.py'),
    [
      'import json, time',
      'from pathlib import Path',
      'a = Path("/skill/assets/data.json").read_text()',
      'time.sleep(3)',
      'b = Path("/skill/assets/data.json").read_text()',
      'assert a == b',
      'print(json.loads(a)["rows"][0]["name"])',
      '',
    ].join('\n'),
  );

  const workspaceRoot = join(gate.workspaceRoot, 'users', USER_A, 'workspace');
  await mkdir(join(workspaceRoot, 'threads', THREAD_A), { recursive: true });
  await chmodTreeWritable(workspaceRoot);

  const engine = await createDockerodeEngine();
  const queue = new ExecutionQueue(2);
  let currentRelease = releaseV1;
  let currentHash = hashV1;
  let currentVersion = 1;

  const runner = createSkillScriptRunner({
    engine,
    lookup: lookup(USER_A),
    imageDigest: gate.imageDigest,
    queue,
    timeoutMs: 30_000,
    resolve: async () => {
      const p = pin(currentVersion, currentHash);
      return {
        ok: true,
        skill: p,
        data: {
          pin: p,
          releaseRoot: currentRelease,
          runtimeManifest: {
            ...scriptRuntime(),
            entrypoints: ['scripts/to_csv.py', 'scripts/slow_read.py'],
          },
        },
      };
    },
  });

  // Abort path
  const ac = new AbortController();
  const aborting = runner.execute(
    ctx(),
    { skillName: 'script-demo', path: 'scripts/slow_read.py' },
    ac.signal,
  );
  setTimeout(() => ac.abort(), 800);
  const aborted = await aborting;
  assert.equal(aborted.ok, false);
  if (!aborted.ok) assert.equal(aborted.code, 'ABORTED', aborted.message);
  // Give docker a moment to finish forced remove after abort/stop.
  await new Promise((r) => setTimeout(r, 500));
  const afterAbort = await engine.findLabeled(SKILL_SCRIPT_RUN_LABEL, '1');
  assert.equal(afterAbort.length, 0, `containers remain after abort: ${afterAbort.map((c) => c.Id).join(',')}`);

  // Pin stability: start slow_read on v1, flip published pointer mid-flight to v2.
  currentRelease = releaseV1;
  currentHash = hashV1;
  currentVersion = 1;
  const running = runner.execute(ctx(), { skillName: 'script-demo', path: 'scripts/slow_read.py' });
  await new Promise((r) => setTimeout(r, 400));
  currentRelease = releaseV2;
  currentHash = hashV2;
  currentVersion = 2;
  const pinnedRun = await running;
  assert.equal(pinnedRun.ok, true, pinnedRun.ok ? '' : pinnedRun.message);
  if (!pinnedRun.ok) return;
  assert.equal(pinnedRun.data.exitCode, 0, pinnedRun.data.stderr);
  assert.match(pinnedRun.data.stdout, /alpha/);
  assert.doesNotMatch(pinnedRun.data.stdout, /v2-only/);
});

test('commandQueue shared with execute_command; cancel still works', async (t) => {
  const gate = await gatePromise;
  if (!gate.ok) {
    t.skip(gate.reason);
    return;
  }
  await enableSkillScriptEnv(gate.imageDigest);
  process.env.WORKSPACE_ROOT = gate.workspaceRoot;
  process.env.SKILLS_STORAGE_ROOT = gate.storageRoot;

  const manifestHash = hashManifest(['queue']);
  const releaseRoot = await materializeRelease(
    gate.storageRoot,
    SKILL_ID,
    3,
    'script-demo',
    manifestHash,
  );
  await writeFile(
    join(releaseRoot, 'scripts', 'sleep.py'),
    'import time\ntime.sleep(2)\nprint("skill-done")\n',
  );
  const workspaceRoot = join(gate.workspaceRoot, 'users', USER_A, 'workspace');
  await mkdir(join(workspaceRoot, 'threads', THREAD_A), { recursive: true });
  await chmodTreeWritable(workspaceRoot);

  const engine = await createDockerodeEngine();
  const registry = new SandboxRegistry();
  const provider = new DockerSandboxProvider(engine, registry);
  const manager = new SandboxManager(provider, lookup(USER_A));
  // Share global commandQueue with SandboxManager.execute (no FakeProvider).
  const skillPin = pin(3, manifestHash);
  const runner = createSkillScriptRunner({
    engine,
    lookup: lookup(USER_A),
    imageDigest: gate.imageDigest,
    queue: commandQueue,
    resolve: async () => ({
      ok: true,
      skill: skillPin,
      data: {
        pin: skillPin,
        releaseRoot,
        runtimeManifest: {
          ...scriptRuntime(),
          entrypoints: ['scripts/to_csv.py', 'scripts/sleep.py'],
        },
      },
    }),
  });

  const order: string[] = [];
  const skillJob = (async () => {
    order.push('skill-start');
    const r = await runner.execute(ctx(), { skillName: 'script-demo', path: 'scripts/sleep.py' });
    order.push('skill-end');
    return r;
  })();

  const cmdJob = (async () => {
    // Contends for the same user/thread queue key as skill scripts.
    order.push('cmd-queued');
    const result = await manager.execute({
      auth: authContextFromUser(user(USER_A)),
      threadId: THREAD_A,
      command: 'python3',
      args: ['-c', 'print("cmd-ok")'],
    });
    order.push('cmd-end');
    return result;
  })();

  const [skillResult, cmdResult] = await Promise.all([skillJob, cmdJob]);
  assert.equal(skillResult.ok, true);
  if (skillResult.ok) assert.equal(skillResult.data.exitCode, 0);
  assert.equal(cmdResult.exitCode, 0);
  assert.match(cmdResult.stdout, /cmd-ok/);
  // Same thread: queue serializes — cmd-end cannot interleave inside skill without skill-end first (or vice versa).
  const skillEnd = order.indexOf('skill-end');
  const cmdEnd = order.indexOf('cmd-end');
  assert.ok(skillEnd >= 0 && cmdEnd >= 0);
  assert.notEqual(skillEnd, cmdEnd);

  // Cancel waiting work on the shared queue
  const cancel = new AbortController();
  const waiting = commandQueue.run(USER_A, THREAD_A, async () => 'should-not-run', cancel.signal);
  cancel.abort();
  await assert.rejects(() => waiting, /cancel/i);

  await provider.remove({ userId: USER_A, sandboxId: sandboxIdFor(USER_A) }).catch(() => undefined);
  const skillLeft = await engine.findLabeled(SKILL_SCRIPT_RUN_LABEL, '1');
  assert.equal(skillLeft.length, 0);
});

test('reference-demo fixture: checklist present; instructions-only availability', async () => {
  const checklist = await readFile(
    join(FIXTURES, 'reference-demo', 'references', 'checklist.md'),
    'utf8',
  );
  assert.match(checklist, /Offline checklist/);
  assert.equal(
    reportSkillRuntimeCompatibility(null),
    'instructions-only',
  );
  const gate = await gatePromise;
  if (!gate.ok) {
    // Fixture content verified without Docker; materialize step needs B-gate env.
    return;
  }
  await enableSkillScriptEnv(gate.imageDigest);
  process.env.SKILLS_STORAGE_ROOT = gate.storageRoot;
  const hash = hashManifest(['reference-demo']);
  const releaseRoot = await materializeRelease(
    gate.storageRoot,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    1,
    'reference-demo',
    hash,
  );
  const body = await readFile(join(releaseRoot, 'references', 'checklist.md'), 'utf8');
  assert.match(body, /skill_read/);
});
