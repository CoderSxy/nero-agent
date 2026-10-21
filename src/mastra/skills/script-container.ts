import type { SandboxNetworkContext } from '../sandbox/network/manager';
import { resolve } from 'node:path';
import {
  SANDBOX_MEMORY_BYTES,
  SANDBOX_NANO_CPUS,
  SANDBOX_PIDS_LIMIT,
  SANDBOX_TMPFS_TMP,
  SANDBOX_UID_GID,
  type DockerCreateOptions,
} from '../sandbox/docker/config';
import { assertContained, workspaceBase } from '../workspace/path';
import { getSkillsStorageRoot } from './config';
import { isSha256Hex } from './validation';

export const SKILL_SCRIPT_RUN_LABEL = 'nero.skill-run';

const PINNED_IMAGE_RE = /^.+@sha256:[a-f0-9]{64}$/i;
const RELEASE_PATH_RE =
  /\/releases\/[0-9a-f-]{36}\/\d+\/[a-f0-9]{64}$/i;

export type SkillScriptContainerInput = {
  network?: SandboxNetworkContext;
  workspaceRoot: string;
  /** Absolute host path to a single verified pin release — INTERNAL ONLY. */
  releaseRoot: string;
  labels?: Record<string, string>;
  imageDigest: string;
};

export type SkillScriptContainerContext = {
  network?: SandboxNetworkContext;
  workspaceRoot: string;
  releaseRoot: string;
};

function assertPinnedImage(imageDigest: string): string {
  const image = imageDigest.trim();
  if (!image || !PINNED_IMAGE_RE.test(image)) {
    throw new Error('Skill script image must be pinned to a sha256 digest');
  }
  return image;
}

function assertUserWorkspaceRoot(workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot);
  if (resolved.includes('\0') || resolved.includes('..')) {
    throw new Error('Workspace root is invalid');
  }
  assertContained(workspaceBase(), resolved);
  if (!/\/users\/[0-9a-f-]{36}\/workspace$/i.test(resolved)) {
    throw new Error('Workspace root is not a per-user workspace');
  }
  return resolved;
}

/**
 * Release must be a single pin materialization under SKILLS_STORAGE_ROOT/releases/<id>/<ver>/<hash>.
 * Rejects the storage root itself (all-skills-root) and any non-pin path.
 */
function assertSkillReleaseRoot(releaseRoot: string): string {
  const resolved = resolve(releaseRoot);
  if (resolved.includes('\0') || resolved.includes('..')) {
    throw new Error('Skill release root is invalid');
  }
  const storageRoot = resolve(getSkillsStorageRoot());
  assertContained(storageRoot, resolved);
  if (resolved === storageRoot || resolved === resolve(storageRoot, 'releases')) {
    throw new Error('Skill script may not mount the all-skills storage root');
  }
  const relative = resolved.slice(storageRoot.length).replace(/\\/g, '/');
  if (!RELEASE_PATH_RE.test(relative)) {
    throw new Error('Skill release root must be a verified pin release path');
  }
  const hash = relative.split('/').pop() ?? '';
  if (!isSha256Hex(hash)) {
    throw new Error('Skill release root must end with a verified manifest hash');
  }
  return resolved;
}

/**
 * Independent skill-script create options. Do NOT pass through validateDockerCreateConfig —
 * that validator intentionally allows only a single workspace bind.
 */
export function createSkillScriptContainerOptions(
  input: SkillScriptContainerInput,
): DockerCreateOptions {
  const workspaceRoot = assertUserWorkspaceRoot(input.workspaceRoot);
  const releaseRoot = assertSkillReleaseRoot(input.releaseRoot);
  const image = assertPinnedImage(input.imageDigest);
  return {
    Image: image,
    User: SANDBOX_UID_GID,
    Env: [],
    Labels: {
      [SKILL_SCRIPT_RUN_LABEL]: '1',
      ...input.labels,
    },
    HostConfig: {
      Privileged: false,
      NetworkMode: input.network?.networkId ?? 'none',
      PidMode: '',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: SANDBOX_PIDS_LIMIT,
      Memory: SANDBOX_MEMORY_BYTES,
      MemorySwap: SANDBOX_MEMORY_BYTES,
      NanoCpus: SANDBOX_NANO_CPUS,
      Tmpfs: { '/tmp': SANDBOX_TMPFS_TMP },
      Binds: [
        `${releaseRoot}:/skill:ro`,
        `${workspaceRoot}:/workspace:rw`,
      ],
    },
  };
}

export function validateSkillScriptContainerOptions(
  options: DockerCreateOptions,
  context: SkillScriptContainerContext,
): void {
  const workspaceRoot = assertUserWorkspaceRoot(context.workspaceRoot);
  const releaseRoot = assertSkillReleaseRoot(context.releaseRoot);

  if (options.User !== SANDBOX_UID_GID) {
    throw new Error('Skill script user must be 10001:10001');
  }
  if (options.HostConfig?.ReadonlyRootfs !== true) {
    throw new Error('Skill script root filesystem must be read-only');
  }
  if (options.HostConfig?.NetworkMode !== (context.network?.networkId ?? 'none')) {
    throw new Error('Skill script network must be none');
  }
  if (options.HostConfig?.Privileged) {
    throw new Error('Skill script must not be privileged');
  }
  if (options.HostConfig?.PidMode === 'host') {
    throw new Error('Skill script must not use host PID or host network');
  }
  if (!options.HostConfig?.CapDrop?.includes('ALL')) {
    throw new Error('Skill script must drop all capabilities');
  }
  if ((options.HostConfig?.CapAdd?.length ?? 0) > 0) {
    throw new Error('Skill script must not add capabilities');
  }
  if ((options.HostConfig?.MemorySwap ?? 0) > (options.HostConfig?.Memory ?? 0)) {
    throw new Error('Skill script memory swap must not exceed memory');
  }
  if (options.Labels?.[SKILL_SCRIPT_RUN_LABEL] !== '1') {
    throw new Error('Skill script container must carry nero.skill-run=1');
  }
  if (!options.Image || !PINNED_IMAGE_RE.test(options.Image)) {
    throw new Error('Skill script image must be pinned to a sha256 digest');
  }

  const serialized = JSON.stringify(options);
  if (serialized.includes('docker.sock')) {
    throw new Error('Skill script must not mount docker.sock');
  }

  const binds = [...(options.HostConfig?.Binds ?? [])].sort();
  const expected = [
    `${releaseRoot}:/skill:ro`,
    `${workspaceRoot}:/workspace:rw`,
  ].sort();
  if (binds.length !== 2 || binds[0] !== expected[0] || binds[1] !== expected[1]) {
    throw new Error('Skill script may bind only one release (/skill:ro) and the user workspace (/workspace:rw)');
  }
}
