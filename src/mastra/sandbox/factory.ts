import { createDockerodeEngine } from './docker/client';
import { DockerSandboxProvider } from './docker/provider';
import type { SandboxProvider } from './provider';
import { SandboxRegistry } from './registry';
import { SandboxCleaner, startSandboxCleanup } from './cleaner';
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
    const provider = new DockerSandboxProvider(await createDockerodeEngine(), registry);
    const cleaner = new SandboxCleaner(provider, registry, () => registry.listOwners(), userId => commandQueue.isUserBusy(userId));
    startSandboxCleanup(cleaner, { onError: error => console.error('Sandbox cleanup failed', error) });
    shared = provider;
    return provider;
  })();
  try {
    return await initializing;
  } finally {
    initializing = undefined;
  }
}
