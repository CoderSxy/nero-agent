import type { DockerEngine } from '../sandbox/docker/client';
import { SANDBOX_MEMORY_BYTES, SANDBOX_NANO_CPUS, SANDBOX_PIDS_LIMIT, SANDBOX_TMPFS_TMP, SANDBOX_UID_GID } from '../sandbox/docker/config';
import { prepareTaskRuntime } from '../sandbox/task-runtime';
import type { SandboxCommandResult, SandboxExecuteOptions } from '../sandbox/types';
import type { SkillRuntimeManifest } from './types';
import type { ReadinessItem } from './readiness';
import { satisfiesVersion } from './runtime-dependencies';

const PYTHON_PACKAGE = `import sys,json,importlib.metadata,importlib.machinery
try:
 version=importlib.metadata.version(sys.argv[1])
 module=sys.argv[2]
 found=True; search=None
 for index,part in enumerate(module.split('.') if module else []):
  spec=importlib.machinery.PathFinder.find_spec('.'.join(module.split('.')[:index+1]),search)
  if spec is None: found=False; break
  search=spec.submodule_search_locations
  if index<len(module.split('.'))-1 and search is None: found=False; break
 print(json.dumps(version if found else None))
except importlib.metadata.PackageNotFoundError: print('null')`;
const NODE_PACKAGE = `const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const resolve=createRequire(process.cwd()+'/package.json');
let result=null;
try { let entry; try {entry=resolve.resolve(process.argv[1]+'/package.json')} catch {entry=resolve.resolve(process.argv[1])}
let dir=path.dirname(entry); for(let i=0;i<20;i++){const file=path.join(dir,'package.json');if(fs.existsSync(file)){const pkg=JSON.parse(fs.readFileSync(file,'utf8'));if(pkg.name===process.argv[1]){result=pkg.version;break}}const up=path.dirname(dir);if(up===dir)break;dir=up;}}
catch(error){if(error.code!=='MODULE_NOT_FOUND' && error.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw error;} console.log(JSON.stringify(result));`;

export function createDockerReadinessProbe(deps: {
  engine: () => Promise<DockerEngine>;
  image: () => string;
  dependenciesEnabled: () => boolean;
  advancedRuntime: (runtime: SkillRuntimeManifest) => boolean;
}) {
  let active = false;
  return async (runtime: SkillRuntimeManifest): Promise<ReadinessItem[]> => {
    // One actual probe per process limits disk/CPU bursts; callers can retry busy results.
    if (active) throw new Error('Runtime probe busy');
    active = true;
    let engine: DockerEngine | undefined, id: string | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      engine = await deps.engine();
      const image = deps.image();
      if (!/^.+@sha256:[a-f0-9]{64}$/i.test(image)) throw new Error('Unpinned image');
      const created = await engine.create({ Image: image, User: SANDBOX_UID_GID, Labels: { 'nero.skill-readiness': '1' }, Env: [], HostConfig: {
        Privileged: false, NetworkMode: 'none', PidMode: '', ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges:true'],
        Memory: SANDBOX_MEMORY_BYTES, MemorySwap: SANDBOX_MEMORY_BYTES, NanoCpus: SANDBOX_NANO_CPUS, PidsLimit: SANDBOX_PIDS_LIMIT,
        Binds: [], Tmpfs: { '/tmp': SANDBOX_TMPFS_TMP, '/workspace': 'rw,exec,nosuid,nodev,size=128m,uid=10001,gid=10001,mode=0700' },
      } });
      id = created.id;
      await engine.start(id);
      const cwd = '/workspace/threads/readiness';
      const exec = async (command: string, args: string[], options?: Partial<SandboxExecuteOptions>): Promise<SandboxCommandResult> => {
        try { return await engine!.exec(id!, command, args, { cwd, timeoutMs: 10000, ...options, abortSignal: controller.signal }); }
        catch (error) {
          // Docker exec can fail before a process exists when the executable is absent.
          if (error instanceof Error && /executable file not found|stat .*no such file or directory/i.test(error.message)) return { exitCode: 127, stdout: '', stderr: '' };
          throw error;
        }
      };
      const init = await exec('mkdir', ['-p', cwd], { cwd: '/workspace' });
      if (init.exitCode !== 0 || init.timedOut) throw new Error('Temporary workspace failed');
      const advanced = deps.advancedRuntime(runtime);
      if (advanced) {
        for (const command of ['python3', ...(deps.dependenciesEnabled() ? ['node'] : [])]) {
          const result = await exec(command, ['--version']);
          if (result.exitCode === 127 || result.exitCode === 126) return [{ kind: 'runtime', name: command, status: 'missing', message: `任务环境初始化需要 ${command}，当前镜像中不可用` }];
          if (result.exitCode !== 0 || result.timedOut) throw new Error('Runtime bootstrap preflight failed');
        }
      }
      const task = advanced ? await prepareTaskRuntime({ execute: exec, cwd, imageDigest: image, dependenciesEnabled: deps.dependenciesEnabled(), abortSignal: controller.signal }) : undefined;
      const options = task ? { env: task.env } : undefined;
      const items: ReadinessItem[] = [{ kind: 'platform', name: 'workspace', status: 'ok', message: '隔离工作区可写' }];
      const available = new Set<string>();
      const runtimes = new Set(runtime.runtimes);
      if (runtime.dependencies?.python?.length) runtimes.add('python3');
      if (runtime.dependencies?.node?.length) runtimes.add('node');
      const check = (kind: ReadinessItem['kind'], name: string, actual: string | null, required?: string) => {
        const status = actual === null ? 'missing' : satisfiesVersion(actual, required) ? 'ok' : 'mismatch';
        items.push({ kind, name, status, ...(actual === null ? {} : { actual }), ...(required ? { required } : {}), message: status === 'missing' ? `缺少 ${name}` : status === 'mismatch' ? `${name} 版本 ${actual} 不满足 ${required}` : `${name} ${actual} 可用` });
      };
      for (const interpreter of runtimes) {
        const command = interpreter === 'python3' ? task?.python ?? 'python3' : interpreter;
        const result = await exec(command, ['--version'], options);
        if (result.timedOut) throw new Error('Interpreter probe timed out');
        if (result.exitCode !== 0 && result.exitCode !== 127 && result.exitCode !== 126) throw new Error('Interpreter probe failed');
        const version = result.exitCode === 0 ? (result.stdout + result.stderr).match(/\b\d+(?:\.\d+){1,3}\b/)?.[0] : null;
        if (result.exitCode === 0 && !version) throw new Error('Invalid interpreter version output');
        check('runtime', interpreter, version ?? null, runtime.runtimeVersions?.[interpreter]);
        if (version) available.add(interpreter);
      }
      for (const kind of ['python', 'node'] as const) {
        for (const dependency of runtime.dependencies?.[kind] ?? []) {
          if (!available.has(kind === 'python' ? 'python3' : 'node')) { check(kind, dependency.name, null, dependency.version); continue; }
          const result = kind === 'python'
            ? await exec(task?.python ?? 'python3', ['-c', PYTHON_PACKAGE, dependency.name, dependency.module ?? ''], options)
            : await exec('node', ['-e', NODE_PACKAGE, dependency.name], options);
          if (result.exitCode !== 0 || result.timedOut) throw new Error('Package probe failed');
          const version: unknown = JSON.parse(result.stdout.trim());
          if (version !== null && typeof version !== 'string') throw new Error('Invalid package output');
          check(kind, dependency.name, version as string | null, dependency.version);
          if (kind === 'python' && dependency.module) items[items.length - 1]!.message += `（模块 ${dependency.module}）`;
        }
      }
      for (const command of runtime.dependencies?.commands ?? []) {
        const result = await exec(command.name, ['--version'], options);
        if (result.timedOut) throw new Error('Command probe timed out');
        if (result.exitCode !== 0 && result.exitCode !== 127 && result.exitCode !== 126) throw new Error('Command version probe failed');
        const actual = result.exitCode === 0 ? (result.stdout + result.stderr).match(/\b\d+(?:\.\d+){1,3}\b/)?.[0] ?? '已安装' : null;
        check('command', command.name, actual, command.version);
      }
      return items;
    } finally {
      clearTimeout(timer);
      try { if (engine && id) await engine.remove(id, true); } finally { active = false; }
    }
  };
}
