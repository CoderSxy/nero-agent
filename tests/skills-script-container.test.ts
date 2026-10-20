/**
 * Task 6: skill script container options — independent of dockerSandboxCreateOptions.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createSkillScriptContainerOptions,
  validateSkillScriptContainerOptions,
  SKILL_SCRIPT_RUN_LABEL,
} from '../src/mastra/skills/script-container.ts';
import {
  SANDBOX_MEMORY_BYTES,
  SANDBOX_NANO_CPUS,
  SANDBOX_PIDS_LIMIT,
  SANDBOX_UID_GID,
  dockerSandboxCreateOptions,
  validateDockerCreateConfig,
} from '../src/mastra/sandbox/docker/config.ts';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SKILL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MANIFEST = 'c'.repeat(64);
const IMAGE = `nero-sandbox@sha256:${'d'.repeat(64)}`;

async function setupRoots() {
  const workspaceBase = await mkdtemp(join(tmpdir(), 'skill-ws-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'skill-store-'));
  process.env.WORKSPACE_ROOT = workspaceBase;
  process.env.SKILLS_STORAGE_ROOT = storageRoot;
  const workspaceRoot = join(workspaceBase, 'users', USER, 'workspace');
  const releaseRoot = join(storageRoot, 'releases', SKILL_ID, '1', MANIFEST);
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(releaseRoot, { recursive: true });
  return { workspaceRoot, releaseRoot, storageRoot };
}

test('skill script container mounts only one release :ro and user workspace :rw', async () => {
  const { workspaceRoot, releaseRoot } = await setupRoots();
  const options = createSkillScriptContainerOptions({
    workspaceRoot,
    releaseRoot,
    labels: { 'nero.skill-run.user': USER },
    imageDigest: IMAGE,
  });
  validateSkillScriptContainerOptions(options, { workspaceRoot, releaseRoot });
  assert.deepEqual(options.HostConfig?.Binds?.slice().sort(), [
    `${releaseRoot}:/skill:ro`,
    `${workspaceRoot}:/workspace:rw`,
  ].sort());
  assert.equal(options.Labels?.[SKILL_SCRIPT_RUN_LABEL], '1');
  assert.equal(options.User, SANDBOX_UID_GID);
  assert.equal(options.HostConfig?.NetworkMode, 'none');
  assert.equal(options.HostConfig?.ReadonlyRootfs, true);
  assert.equal(options.HostConfig?.Privileged, false);
  assert.ok(options.HostConfig?.CapDrop?.includes('ALL'));
  assert.equal(options.HostConfig?.CapAdd?.length ?? 0, 0);
  assert.equal(options.HostConfig?.Memory, SANDBOX_MEMORY_BYTES);
  assert.equal(options.HostConfig?.NanoCpus, SANDBOX_NANO_CPUS);
  assert.equal(options.HostConfig?.PidsLimit, SANDBOX_PIDS_LIMIT);
});

test('skill script container rejects all-skills-root, other user workspace, docker.sock, unpinned digest', async () => {
  const { workspaceRoot, releaseRoot, storageRoot } = await setupRoots();

  assert.throws(
    () =>
      createSkillScriptContainerOptions({
        workspaceRoot,
        releaseRoot: storageRoot,
        labels: {},
        imageDigest: IMAGE,
      }),
    /all-skills|release|storage root/i,
  );

  const otherUser = join(process.env.WORKSPACE_ROOT!, 'users', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'workspace');
  await mkdir(otherUser, { recursive: true });
  assert.throws(
    () =>
      validateSkillScriptContainerOptions(
        createSkillScriptContainerOptions({
          workspaceRoot: otherUser,
          releaseRoot,
          labels: {},
          imageDigest: IMAGE,
        }),
        { workspaceRoot, releaseRoot },
      ),
    /workspace/i,
  );

  const withSock = createSkillScriptContainerOptions({
    workspaceRoot,
    releaseRoot,
    labels: {},
    imageDigest: IMAGE,
  });
  withSock.HostConfig!.Binds!.push('/var/run/docker.sock:/var/run/docker.sock');
  assert.throws(
    () => validateSkillScriptContainerOptions(withSock, { workspaceRoot, releaseRoot }),
    /docker\.sock/i,
  );

  assert.throws(
    () =>
      createSkillScriptContainerOptions({
        workspaceRoot,
        releaseRoot,
        labels: {},
        imageDigest: 'nero-sandbox:latest',
      }),
    /digest|sha256/i,
  );
});

test('general dockerSandboxCreateOptions still allow only a single workspace bind', async () => {
  const { workspaceRoot, releaseRoot } = await setupRoots();
  process.env.SANDBOX_IMAGE = IMAGE;
  const general = dockerSandboxCreateOptions(workspaceRoot, { 'nero.sandbox': '1' });
  validateDockerCreateConfig(general, workspaceRoot);
  assert.deepEqual(general.HostConfig?.Binds, [`${workspaceRoot}:/workspace:rw`]);

  // Skill options must NOT pass the general single-bind validator.
  const skill = createSkillScriptContainerOptions({
    workspaceRoot,
    releaseRoot,
    labels: {},
    imageDigest: IMAGE,
  });
  assert.throws(() => validateDockerCreateConfig(skill, workspaceRoot), /only the user workspace/i);
});
