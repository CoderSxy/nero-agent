import { posix } from 'node:path';
import type { SkillPin } from './types';
import type { SandboxCommandResult, SandboxExecuteOptions } from '../sandbox/types';
import { taskRuntimePaths } from '../sandbox/task-runtime';

// Runs as UID 10001 in a container with /skill:ro and only this user's workspace.
// Never resolve or write destination paths using the privileged host filesystem.
const COPY_RESOURCES = `import pathlib,sys,os,shutil,uuid
source=pathlib.Path(sys.argv[1]);task=pathlib.Path(sys.argv[2])
if task.is_symlink(): raise RuntimeError('Task root must not be a symlink')
def directory(path):
 path.mkdir(exist_ok=True)
 if path.is_symlink() or not path.is_dir(): raise RuntimeError('Invalid task directory')
root=task
for part in ['.runtime','skills',sys.argv[3],sys.argv[4]]:
 root=root/part;directory(root)
temporary=root/('.package-'+uuid.uuid4().hex+'.json')
with temporary.open('x') as handle: handle.write('{}')
os.replace(temporary,root/'package.json')
def remove(path):
 if path.is_symlink() or path.is_file(): path.unlink()
 elif path.exists(): shutil.rmtree(path)
destination=root/'package';remove(destination);directory(destination)
def copy(src,dst):
 for entry in src.iterdir():
  target=dst/entry.name
  if entry.is_symlink(): raise RuntimeError('Unsafe skill resource')
  if entry.is_dir(): directory(target);copy(entry,target)
  elif entry.is_file():
   with entry.open('rb') as reader,target.open('xb') as writer: shutil.copyfileobj(reader,writer)
  else: raise RuntimeError('Unsafe skill resource')
copy(source,destination)
modules=root/'node_modules';remove(modules)
modules.symlink_to(os.path.relpath(task/'node_modules',root))
`;

export async function materializeSkillExecution(input: {
  pin: SkillPin;
  taskContainerRoot: string;
  execute: (command: string, args: string[], options: SandboxExecuteOptions) => Promise<SandboxCommandResult>;
  abortSignal?: AbortSignal;
}) {
  const { pin } = input;
  if (!/^[a-f0-9-]{36}$/i.test(pin.skillId) || !/^[a-f0-9]{64}$/i.test(pin.manifestHash)) throw new Error('Invalid skill pin');
  taskRuntimePaths(input.taskContainerRoot);
  const result = await input.execute('python3', ['-c', COPY_RESOURCES, '/skill', input.taskContainerRoot, pin.skillId, pin.manifestHash], {
    cwd: input.taskContainerRoot, timeoutMs: 120000, abortSignal: input.abortSignal,
  });
  if (result.exitCode !== 0) throw new Error('Skill resource preparation failed: ' + result.stderr);
  const containerRoot = posix.join(input.taskContainerRoot, '.runtime', 'skills', pin.skillId, pin.manifestHash, 'package');
  return { containerRoot, entrypoint: (path: string) => posix.join(containerRoot, path) };
}
