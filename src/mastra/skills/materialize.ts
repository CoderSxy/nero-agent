import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { join, relative, posix } from 'node:path';
import type { SkillPin } from './types';
import { taskRuntimePaths } from '../sandbox/task-runtime';
async function directory(path: string) { await mkdir(path, { recursive: true }); if ((await lstat(path)).isSymbolicLink())
    throw new Error('Skill task directory must not be a symlink'); }
export async function materializeSkillExecution(input: {
    pin: SkillPin;
    verifiedReleaseRoot: string;
    taskHostRoot: string;
    taskContainerRoot: string;
}) {
    const { pin } = input;
    if (!/^[a-f0-9-]{36}$/i.test(pin.skillId) || !/^[a-f0-9]{64}$/i.test(pin.manifestHash))
        throw new Error('Invalid skill pin');
    if ((await lstat(input.taskHostRoot)).isSymbolicLink())
        throw new Error('Task root must not be a symlink');
    taskRuntimePaths(input.taskContainerRoot);
    let dir = input.taskHostRoot;
    for (const part of ['.runtime', 'skills', pin.skillId, pin.manifestHash]) {
        dir = join(dir, part);
        await directory(dir);
    }
    // Isolate package type from the task's package.json; a skill's own scope still wins.
    const metadataTemp=join(dir,'.package-'+randomUUID()+'.json');
    await writeFile(metadataTemp,'{}',{flag:'wx',mode:0o644});
    await rename(metadataTemp,join(dir,'package.json'));
    const hostRoot = join(dir, 'package');
    await rm(hostRoot, { recursive: true, force: true });
    await directory(hostRoot);
    async function copy(source: string, dest: string) {
        for (const entry of await readdir(source, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
                throw new Error('Unsafe skill resource');
            const from = join(source, entry.name), to = join(dest, entry.name);
            if (entry.isDirectory()) {
                await directory(to);
                await copy(from, to);
            }
            else
                await writeFile(to, await readFile(from), { mode: 0o644, flag: 'wx' });
        }
    }
    await copy(input.verifiedReleaseRoot, hostRoot);
    const modules = join(dir, 'node_modules');
    await rm(modules, { recursive: true, force: true });
    await symlink(relative(dir, join(input.taskHostRoot, 'node_modules')), modules);
    const containerRoot = posix.join(input.taskContainerRoot, '.runtime', 'skills', pin.skillId, pin.manifestHash, 'package');
    return { hostRoot, containerRoot, entrypoint: (path: string) => posix.join(containerRoot, path) };
}
