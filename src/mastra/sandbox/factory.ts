import { createDockerodeEngine, type DockerEngine } from './docker/client';
import { DockerSandboxProvider } from './docker/provider';
import type { SandboxProvider } from './provider';
import { SandboxRegistry } from './registry';
import {
  SandboxCleaner,
  cleanupOrphanSkillScriptContainers,
  startSandboxCleanup,
} from './cleaner';
import { sandboxNetworkManager } from './network/manager';
import { isSandboxCommandsEnabled } from '../workspace/config';
import { commandQueue } from './execution-queue';

let shared: SandboxProvider | undefined;
let initializing: Promise<SandboxProvider> | undefined;

export async function sandboxProvider(): Promise<SandboxProvider> {
  if (shared) return shared;
  if (initializing) return initializing;
  if (process.env.SANDBOX_PROVIDER !== 'docker') {
    throw new Error('SANDBOX_PROVIDER must be docker when sandbox commands are enabled');
  }
  initializing = (async () => {
    const registry = new SandboxRegistry();
    const engine = await createDockerodeEngine();
    // Restore cleanup even after switching back to offline mode.
    const networks=await sandboxNetworkManager();
    await networks.sweep();
    const provider = new DockerSandboxProvider(engine, registry, networks);
    const cleaner = new SandboxCleaner(
      provider,
      registry,
      () => registry.listOwners(),
      userId => commandQueue.isUserBusy(userId),
    );
    startSandboxCleanup({
      runOnce: async (now) => {
        const report = await cleaner.runOnce(now);
        await cleanupOrphanSkillScriptContainers(engine as DockerEngine, { now }).catch(error => {
          console.error('Skill script orphan cleanup failed', error);
          return { removed: [], skipped: [] };
        });
        return report;
      },
    }, { onError: error => console.error('Sandbox cleanup failed', error) });
    shared = provider;
    return provider;
  })();
  try {
    return await initializing;
  } finally {
    initializing = undefined;
  }
}

export function startSandboxReconcile():void {
  if(isSandboxCommandsEnabled()&&process.env.SANDBOX_PROVIDER==='docker')
    void sandboxProvider().catch(error=>console.error('Sandbox reconciliation failed',error));
}
