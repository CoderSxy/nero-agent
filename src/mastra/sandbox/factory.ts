import { createDockerodeEngine } from './docker/client';
import { DockerSandboxProvider } from './docker/provider';
import { FakeSandboxProvider } from './fake-provider';
import type { SandboxProvider } from './provider';
import { SandboxRegistry } from './registry';

let shared: SandboxProvider | undefined;

export async function sandboxProvider(): Promise<SandboxProvider> {
  if (shared) return shared;
  if (process.env.SANDBOX_PROVIDER === 'docker') {
    shared = new DockerSandboxProvider(await createDockerodeEngine(), new SandboxRegistry());
    return shared;
  }
  shared = new FakeSandboxProvider();
  return shared;
}
