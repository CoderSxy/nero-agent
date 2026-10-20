import type { DockerEngine } from './docker/client';
import type { SandboxProvider } from './provider';
import type { SandboxRegistry } from './registry';
import type { SandboxOwner } from './types';
import { SKILL_SCRIPT_RUN_LABEL } from '../skills/script-container';

export type CleanupReport = {
  stopped: string[];
  removed: string[];
  skipped: string[];
};

export type SkillScriptCleanupReport = {
  removed: string[];
  skipped: string[];
};

/** Default: reclaim skill-run containers older than 15 minutes. */
export function skillScriptOrphanMaxAgeMs(): number {
  return Number(process.env.SKILL_SCRIPT_ORPHAN_MAX_AGE_MS ?? 15 * 60 * 1000);
}

/**
 * Remove orphan short-lived skill script containers labeled `nero.skill-run=1`.
 * Never selects or removes ordinary user sandboxes (`nero.sandbox=1`).
 */
export async function cleanupOrphanSkillScriptContainers(
  engine: Pick<DockerEngine, 'findLabeled' | 'remove' | 'inspect'>,
  options: { now?: number; maxAgeMs?: number } = {},
): Promise<SkillScriptCleanupReport> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? skillScriptOrphanMaxAgeMs();
  const report: SkillScriptCleanupReport = { removed: [], skipped: [] };
  const labeled = await engine.findLabeled(SKILL_SCRIPT_RUN_LABEL, '1');
  for (const container of labeled) {
    if (container.Config?.Labels?.['nero.sandbox'] === '1') {
      report.skipped.push(container.Id);
      continue;
    }
    // Prefer Created when present; DockerInspect in this repo may omit it — then remove when maxAgeMs=0.
    const createdMs = (container as { Created?: string | number }).Created;
    let ageOk = maxAgeMs <= 0;
    if (typeof createdMs === 'string') {
      const parsed = Date.parse(createdMs);
      if (Number.isFinite(parsed)) ageOk = now - parsed >= maxAgeMs;
    } else if (typeof createdMs === 'number' && createdMs > 0) {
      // dockerode sometimes returns unix seconds
      const ms = createdMs < 1e12 ? createdMs * 1000 : createdMs;
      ageOk = now - ms >= maxAgeMs;
    }
    if (!ageOk) {
      report.skipped.push(container.Id);
      continue;
    }
    try {
      await engine.remove(container.Id, true);
      report.removed.push(container.Id);
    } catch {
      report.skipped.push(container.Id);
    }
  }
  return report;
}

export function idleStopMs(): number {
  return Number(process.env.SANDBOX_IDLE_STOP_MS ?? 30 * 60 * 1000);
}

export function removeAfterMs(): number {
  return Number(process.env.SANDBOX_REMOVE_AFTER_MS ?? 24 * 60 * 60 * 1000);
}

export class SandboxCleaner {
  constructor(
    private readonly provider: SandboxProvider,
    private readonly registry: SandboxRegistry,
    private readonly listUsers: () => Promise<SandboxOwner[]>,
    private readonly isBusy: (userId: string) => boolean,
  ) {}

  async runOnce(now: number): Promise<CleanupReport> {
    const report: CleanupReport = { stopped: [], removed: [], skipped: [] };
    for (const owner of await this.listUsers()) {
      if (this.isBusy(owner.userId)) {
        report.skipped.push(owner.userId);
        continue;
      }
      const record = await this.registry.getByUser(owner.userId);
      if (!record) continue;
      const idleFor = now - record.lastActiveAt;
      if (record.status === 'running' && idleFor >= idleStopMs()) {
        await this.provider.stop(owner);
        report.stopped.push(owner.userId);
        continue;
      }
      if (record.status === 'stopped' && idleFor >= removeAfterMs()) {
        await this.provider.remove(owner);
        report.removed.push(owner.userId);
      }
    }
    return report;
  }
}

type CleanupTimer = { unref(): void; close(): void };

export function startSandboxCleanup(
  cleaner: Pick<SandboxCleaner, 'runOnce'>,
  options: {
    schedule?: (callback: () => void) => CleanupTimer;
    now?: () => number;
    onError?: (error: unknown) => void;
  } = {},
): () => void {
  let running = false;
  const schedule = options.schedule ?? ((callback: () => void) => {
    const interval = setInterval(callback, 60_000);
    return { unref: () => interval.unref(), close: () => clearInterval(interval) };
  });
  const timer = schedule(() => {
    if (running) return;
    running = true;
    void cleaner.runOnce((options.now ?? Date.now)())
      .catch(error => (options.onError ?? console.error)(error))
      .finally(() => { running = false; });
  });
  timer.unref();
  return () => timer.close();
}
