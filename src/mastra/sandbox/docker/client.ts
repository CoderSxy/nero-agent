import type { DockerCreateOptions } from './config';
import type { SandboxCommandResult, SandboxExecuteOptions } from '../types';
import type Docker from 'dockerode';

export type DockerInspect = {
  Id: string;
  Image?: string;
  Created?: string | number;
  NetworkSettings?: { Networks?: Record<string,unknown> };
  State: { Running: boolean; Status: string };
  Config?: { Labels?: Record<string, string>; User?: string; Image?:string };
  HostConfig?: DockerCreateOptions['HostConfig'];
  Mounts?: Array<{ Source: string; Destination: string }>;
};

export interface DockerEngine {
  resolveImageId?(image: string): Promise<string>;
  create(options: DockerCreateOptions): Promise<{ id: string }>;
  start(id: string): Promise<void>;
  inspect(id: string): Promise<DockerInspect | null>;
  findLabeled(label: string, value: string): Promise<DockerInspect[]>;
  exec(id: string, command: string, args: string[], options: SandboxExecuteOptions): Promise<SandboxCommandResult>;
  stop(id: string): Promise<void>;
  remove(id: string, force?: boolean): Promise<void>;
}

/**
 * Registry pins use name@sha256:<content-digest>. Locally built images often only have an
 * image ID (also sha256:…). If that ID exists locally, rewrite Image so create does not try
 * to pull a non-existent registry digest.
 */
async function resolveImageRef(docker: Docker, image: string | undefined): Promise<string | undefined> {
  if (!image) return image;
  const match = image.match(/^(.+)@sha256:([a-f0-9]{64})$/i);
  if (!match) return image;
  const digest = match[2]!;
  const localId = `sha256:${digest}`;
  try {
    await docker.getImage(localId).inspect();
    return localId;
  } catch {
    return image;
  }
}

export async function createDockerodeEngine(dockerInstance?: Docker): Promise<DockerEngine> {
  const { default: DockerConstructor } = await import('dockerode');
  const docker = dockerInstance ?? new DockerConstructor();
  return {
    async resolveImageId(image){const ref=await resolveImageRef(docker,image);return (await docker.getImage(ref!).inspect()).Id},
    async create(options) {
      const Image = await resolveImageRef(docker, options.Image);
      const container = await docker.createContainer({ ...options, Image });
      return { id: container.id };
    },
    async start(id) {
      await docker.getContainer(id).start();
    },
    async inspect(id) {
      try {
        return await docker.getContainer(id).inspect();
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) return null;
        throw error;
      }
    },
    async findLabeled(label, value) {
      const list = await docker.listContainers({ all: true, filters: { label: [`${label}=${value}`] } });
      const inspected = await Promise.all(list.map(item => docker.getContainer(item.Id).inspect()));
      return inspected;
    },
    async exec(id, command, args, options) {
      const container = docker.getContainer(id);
      if (options.abortSignal?.aborted) throw new Error('Sandbox command aborted');
      const exec = await container.exec({
        Cmd: [command, ...args],
        WorkingDir: options.cwd,
        AttachStdout: true,
        AttachStderr: true,
        User: '10001:10001',
        Env: options.env,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        container.modem.demuxStream(stream, collect(stdout), collect(stderr));
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          options.abortSignal?.removeEventListener('abort', onAbort);
        };
        const terminate = async (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          stream.destroy();
          try {
            await container.stop({ t: 0 });
          } catch (stopError) {
            try {
              await container.kill();
            } catch (killError) {
              reject(new AggregateError([stopError, killError], 'Unable to terminate sandbox container'));
              return;
            }
          }
          reject(error);
        };
        const onAbort = () => { void terminate(new Error('Sandbox command aborted')); };
        const timer = setTimeout(() => {
          void terminate(new Error('Sandbox command timed out'));
        }, options.timeoutMs);
        options.abortSignal?.addEventListener('abort', onAbort, { once: true });
        if (options.abortSignal?.aborted) onAbort();
        stream.on('end', () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        });
        stream.on('error', error => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      });
      const inspect = await exec.inspect();
      return {
        exitCode: inspect.ExitCode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
    },
    async stop(id) {
      try {
        await docker.getContainer(id).stop({ t: 5 });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 304) throw error;
      }
    },
    async remove(id, force = false) {
      await docker.getContainer(id).remove({ force });
    },
  };
}

function collect(chunks: Buffer[]) {
  const maxBytes = 1024 * 1024;
  let total = 0;
  return {
    write(chunk: Buffer) {
      if (total >= maxBytes) return;
      const kept = Buffer.from(chunk).subarray(0, maxBytes - total);
      chunks.push(kept);
      total += kept.byteLength;
    },
  };
}
