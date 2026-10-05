import { resolve } from 'node:path';
import { assertContained, workspaceBase } from '../../workspace/path';

export const SANDBOX_UID_GID = '10001:10001';
export const SANDBOX_MEMORY_BYTES = 384 * 1024 * 1024;
export const SANDBOX_NANO_CPUS = 500_000_000;
export const SANDBOX_PIDS_LIMIT = 128;
export const SANDBOX_TMPFS_TMP = 'rw,noexec,nosuid,size=256m';

export type DockerHostConfig = {
  Privileged?: boolean;
  NetworkMode?: string;
  PidMode?: string;
  ReadonlyRootfs?: boolean;
  CapDrop?: string[];
  CapAdd?: string[];
  SecurityOpt?: string[];
  PidsLimit?: number;
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
  Tmpfs?: Record<string, string>;
  Binds?: string[];
};

export type DockerCreateOptions = {
  Image: string;
  User: string;
  Env?: string[];
  Labels?: Record<string, string>;
  HostConfig?: DockerHostConfig;
};

export function assertSandboxImage(): string {
  const image = process.env.SANDBOX_IMAGE?.trim();
  if (!image || !/@sha256:[a-f0-9]{64}$/i.test(image)) {
    throw new Error('SANDBOX_IMAGE must be pinned to a sha256 digest');
  }
  return image;
}

export function dockerSandboxCreateOptions(workspaceRoot: string, labels: Record<string, string> = {}): DockerCreateOptions {
  const root = assertUserWorkspaceRoot(workspaceRoot);
  return {
    Image: assertSandboxImage(),
    User: SANDBOX_UID_GID,
    Env: [],
    Labels: { 'nero.sandbox': '1', ...labels },
    HostConfig: {
      Privileged: false,
      NetworkMode: 'none',
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
      Binds: [`${root}:/workspace:rw`],
    },
  };
}

export function validateDockerCreateConfig(options: DockerCreateOptions, workspaceRoot: string): void {
  const root = assertUserWorkspaceRoot(workspaceRoot);
  if (options.User !== SANDBOX_UID_GID) throw new Error('Sandbox user must be 10001:10001');
  if (options.HostConfig?.ReadonlyRootfs !== true) throw new Error('Sandbox root filesystem must be read-only');
  if (options.HostConfig?.NetworkMode !== 'none') throw new Error('Sandbox network must be none');
  if (options.HostConfig?.Privileged) throw new Error('Sandbox must not be privileged');
  if (options.HostConfig?.PidMode === 'host') {
    throw new Error('Sandbox must not use host PID or host network');
  }
  if (!options.HostConfig?.CapDrop?.includes('ALL')) throw new Error('Sandbox must drop all capabilities');
  if ((options.HostConfig?.CapAdd?.length ?? 0) > 0) throw new Error('Sandbox must not add capabilities');
  if ((options.HostConfig?.MemorySwap ?? 0) > (options.HostConfig?.Memory ?? 0)) {
    throw new Error('Sandbox memory swap must not exceed memory');
  }
  const binds = options.HostConfig?.Binds ?? [];
  if (binds.length !== 1 || binds[0] !== `${root}:/workspace:rw`) {
    throw new Error('Sandbox may bind only the user workspace');
  }
  const serialized = JSON.stringify(options);
  if (serialized.includes('docker.sock')) throw new Error('Sandbox must not mount the Docker socket');
}

function assertUserWorkspaceRoot(workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot);
  if (resolved.includes('\0') || resolved.includes('..')) throw new Error('Workspace root is invalid');
  assertContained(workspaceBase(), resolved);
  if (!/\/users\/[0-9a-f-]{36}\/workspace$/i.test(resolved)) {
    throw new Error('Workspace root is not a per-user workspace');
  }
  return resolved;
}
