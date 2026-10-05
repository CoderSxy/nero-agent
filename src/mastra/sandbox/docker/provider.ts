import { dockerSandboxCreateOptions, validateDockerCreateConfig } from './config';
import type { DockerEngine } from './client';
import type { SandboxProvider } from '../provider';
import type { SandboxRegistry } from '../registry';
import type { SandboxCommandResult, SandboxExecuteOptions, SandboxInspect, SandboxOwner } from '../types';
import { sandboxMaxConcurrent } from '../../workspace/config';

const USER_LABEL = 'nero.sandbox.user';

export class DockerSandboxProvider implements SandboxProvider {
  private readonly locks = new Map<string, Promise<void>>();
  private provisionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly engine: DockerEngine,
    private readonly registry: SandboxRegistry,
  ) {}

  async ensureRunning(owner: SandboxOwner, workspaceRoot: string): Promise<SandboxInspect> {
    return this.withProvisionLock(() => this.withLock(owner.userId, async () => {
      const existing = await this.reconcile(owner, workspaceRoot);
      if (existing?.status === 'running' && existing.containerId) {
        await this.registry.upsert({ ...existing, lastActiveAt: Date.now() });
        return { sandboxId: owner.sandboxId, status: 'running', workspaceRoot };
      }
      const running = (await this.engine.findLabeled('nero.sandbox', '1'))
        .filter(container => container.State.Running).length;
      if (running >= sandboxMaxConcurrent()) throw new Error('Running sandbox limit reached');
      if (existing?.status === 'stopped' && existing.containerId) {
        await this.engine.start(existing.containerId);
        await this.registry.upsert({ ...existing, status: 'running', lastActiveAt: Date.now() });
        return { sandboxId: owner.sandboxId, status: 'running', workspaceRoot };
      }
      const options = dockerSandboxCreateOptions(workspaceRoot, {
        [USER_LABEL]: owner.userId,
        'nero.sandbox.id': owner.sandboxId,
      });
      validateDockerCreateConfig(options, workspaceRoot);
      const created = await this.engine.create(options);
      await this.engine.start(created.id);
      await this.registry.upsert({
        userId: owner.userId,
        sandboxId: owner.sandboxId,
        containerId: created.id,
        status: 'running',
        workspaceRoot,
        lastActiveAt: Date.now(),
      });
      return { sandboxId: owner.sandboxId, status: 'running', workspaceRoot };
    }));
  }

  async execute(
    owner: SandboxOwner,
    command: string,
    args: string[],
    options: SandboxExecuteOptions,
  ): Promise<SandboxCommandResult> {
    const record = await this.registry.getByUser(owner.userId);
    if (!record?.containerId) throw new Error('Sandbox is not running');
    return this.engine.exec(record.containerId, command, args, options);
  }

  async stop(owner: SandboxOwner): Promise<void> {
    await this.withLock(owner.userId, async () => {
      const record = await this.registry.getByUser(owner.userId);
      if (!record?.containerId) return;
      await this.engine.stop(record.containerId);
      await this.registry.upsert({ ...record, status: 'stopped', lastActiveAt: Date.now() });
    });
  }

  async remove(owner: SandboxOwner): Promise<void> {
    await this.withLock(owner.userId, async () => {
      const record = await this.registry.getByUser(owner.userId);
      if (record?.containerId) await this.engine.remove(record.containerId, true);
      await this.registry.clearContainer(owner, 'missing');
    });
  }

  async inspect(owner: SandboxOwner): Promise<SandboxInspect> {
    const record = await this.reconcile(owner, (await this.registry.getByUser(owner.userId))?.workspaceRoot ?? '');
    return {
      sandboxId: owner.sandboxId,
      status: record?.status ?? 'missing',
      workspaceRoot: record?.workspaceRoot,
    };
  }

  private async reconcile(owner: SandboxOwner, workspaceRoot: string) {
    const record = await this.registry.getByUser(owner.userId);
    if (record?.containerId) {
      const info = await this.engine.inspect(record.containerId);
      if (!info) return { ...record, containerId: undefined, status: 'missing' as const };
      if (info.Config?.Labels?.[USER_LABEL] !== owner.userId) {
        throw new Error('Sandbox container label does not match owner');
      }
      const bind = info.HostConfig?.Binds?.[0] ?? `${info.Mounts?.[0]?.Source}:${info.Mounts?.[0]?.Destination}:rw`;
      if (workspaceRoot && bind !== `${workspaceRoot}:/workspace:rw`) {
        throw new Error('Sandbox container mount does not match workspace');
      }
      return { ...record, status: info.State.Running ? 'running' as const : 'stopped' as const };
    }
    const labeled = await this.engine.findLabeled(USER_LABEL, owner.userId);
    const match = labeled[0];
    if (!match) return record;
    const next = {
      userId: owner.userId,
      sandboxId: owner.sandboxId,
      containerId: match.Id,
      status: match.State.Running ? 'running' as const : 'stopped' as const,
      workspaceRoot: record?.workspaceRoot ?? workspaceRoot,
      lastActiveAt: Date.now(),
    };
    await this.registry.upsert(next);
    return next;
  }

  private async withLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(userId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(userId) === tail) this.locks.delete(userId);
    }
  }

  private async withProvisionLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.provisionTail;
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.provisionTail = previous.then(() => current);
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}
