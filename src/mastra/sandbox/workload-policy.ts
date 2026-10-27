import { readFile, access } from 'node:fs/promises';
import type { DockerCreateOptions } from './docker/config';
import type { DockerInspect } from './docker/client';

export const WORKLOAD_SLICE = 'nero-runtime-workloads.slice';
const ROOT = '/sys/fs/cgroup/nero.slice/nero-runtime.slice';
const CHILD = `${ROOT}/${WORKLOAD_SLICE}`;
const MIB = 1024 * 1024;
export const GUARD_TRIP_PATH = '/run/nero-resource-guard/tripped';
export type HostBudget = { available: number; runtimeCurrent: number; runtimeMax: number;
  workloadsCurrent: number; workloadsMax: number; tripped: boolean };
type Environment = Record<string, string | undefined>;
const kinds = ['nero.sandbox', 'nero.skill-run', 'nero.skill-readiness', 'nero.egress'];

async function readHostBudget(): Promise<HostBudget> {
  if (process.platform !== 'linux') throw new Error('Resource guard requires Linux cgroup v2');
  const [meminfo, current, max, childCurrent, childMax] = await Promise.all([
    readFile('/proc/meminfo', 'utf8'), readFile(`${ROOT}/memory.current`, 'utf8'), readFile(`${ROOT}/memory.max`, 'utf8'),
    readFile(`${CHILD}/memory.current`, 'utf8'), readFile(`${CHILD}/memory.max`, 'utf8'),
  ]);
  let tripped = false;
  try { await access(GUARD_TRIP_PATH); tripped = true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { available: Number(meminfo.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]) * 1024,
    runtimeCurrent: Number(current), runtimeMax: Number(max), workloadsCurrent: Number(childCurrent), workloadsMax: Number(childMax), tripped };
}
export function createWorkloadPolicy(env: Environment = process.env, snapshot: () => Promise<HostBudget> = readHostBudget) {
  const enabled = () => env.NERO_RESOURCE_GUARD_ENABLED === 'true';
  const invocation = () => {
    if (!/^[a-f0-9]{32}$/.test(env.INVOCATION_ID ?? '')) throw new Error('Resource guard requires systemd invocation ID');
    return env.INVOCATION_ID!;
  };
  async function admit(extra: number) {
    const budget = await snapshot();
    if (budget.tripped) throw new Error('Resource guard tripped; manual recovery is required');
    if (Object.values(budget).some(value => typeof value === 'number' && (!Number.isFinite(value) || value < 0))
      || budget.runtimeMax <= 0 || budget.runtimeMax > 960 * MIB || budget.workloadsMax <= 0 || budget.workloadsMax > 512 * MIB)
      throw new Error('Resource memory limits unavailable or unbounded');
    if (budget.available < 256 * MIB + extra || budget.runtimeCurrent + extra > budget.runtimeMax
      || budget.workloadsCurrent + extra > budget.workloadsMax) throw new Error('Host memory budget exhausted; retry after active work finishes');
  }
  function owns(labels?: Record<string, string>) { return kinds.some(kind => labels?.[kind] === '1'); }
  function matches(info: DockerInspect) {
    return owns(info.Config?.Labels) && info.Config?.Labels?.['nero.runtime.invocation'] === invocation()
      && info.HostConfig?.CgroupParent === WORKLOAD_SLICE;
  }
  return {
    enabled,
    compatible(info: DockerInspect | null | undefined) { return !enabled() || Boolean(info && matches(info)); },
    async beforeCreate(options: DockerCreateOptions): Promise<DockerCreateOptions> {
      if (!enabled()) return options;
      if (!owns(options.Labels)) throw new Error('Unowned container cannot enter the workload pool');
      const memory = options.HostConfig?.Memory ?? 0;
      const limit = options.Labels?.['nero.egress'] === '1' ? 128 * MIB : 384 * MIB;
      if (!Number.isInteger(memory) || memory <= 0 || memory > limit) throw new Error('Invalid container memory budget');
      const owner = invocation();
      await admit(memory);
      return { ...options, Labels: { ...options.Labels, 'nero.runtime.managed': '1', 'nero.runtime.invocation': owner },
        HostConfig: { ...options.HostConfig, CgroupParent: WORKLOAD_SLICE, MemorySwap: memory } };
    },
    async beforeUse(info: DockerInspect, starting = false): Promise<void> {
      if (!enabled()) return;
      if (!matches(info)) throw new Error('Container has stale invocation or resource policy; recreate it');
      const memory = info.HostConfig?.Memory ?? 0;
      if (memory <= 0 || memory > 384 * MIB || info.HostConfig?.MemorySwap !== memory) throw new Error('Container memory limit is invalid');
      await admit(starting ? memory : 0);
    },
  };
}
export const workloadPolicy = createWorkloadPolicy();
