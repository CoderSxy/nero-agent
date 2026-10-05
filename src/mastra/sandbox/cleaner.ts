import type { SandboxProvider } from './provider';
import type { SandboxRegistry } from './registry';
import type { SandboxOwner } from './types';

export type CleanupReport = {
  stopped: string[];
  removed: string[];
  skipped: string[];
};

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
