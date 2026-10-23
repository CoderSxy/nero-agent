import { readFile, writeFile, stat, copyFile, rename, unlink, chown, chmod } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { isAbsolute, dirname, join } from 'node:path';
const [envFile, image, mode] = process.argv.slice(2);
if (!envFile || !image || !['--check','--apply'].includes(mode)) {
  throw new Error('Usage: configure-runtime.mjs <env-file> <pinned-image> --check|--apply');
}
if (!/^.+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Pinned SANDBOX_IMAGE required');
const before = await readFile(envFile, 'utf8');
const env = parseEnv(before);
if (env.WORKSPACE_HOST_QUOTA_VERIFIED !== 'true') {
  throw new Error('Host project quota has not been verified. Configure/enforce it and run check-workspace-quota.mjs first; this script never sets WORKSPACE_HOST_QUOTA_VERIFIED.');
}
for (const key of ['SKILLS_STORAGE_ROOT','SKILLS_IMPORT_TEMP_ROOT','WORKSPACE_ROOT']) {
  if (!env[key] || !isAbsolute(env[key])) throw new Error(`${key} must already be an explicit absolute persistent directory`);
  if (!(await stat(env[key])).isDirectory()) throw new Error(`${key} is not a directory`);
}
if (env.SKILLS_STORAGE_ROOT === env.SKILLS_IMPORT_TEMP_ROOT) throw new Error('Skill storage and import roots must differ');
if (!env.DATABASE_URL) throw new Error('DATABASE_URL must be configured');
if (env.SANDBOX_COMMANDS_ENABLED === 'true' && (env.SANDBOX_NETWORK_MODE === 'public-http' || env.SANDBOX_DEPENDENCIES_ENABLED === 'true')) {
  throw new Error('Existing public-network or per-task dependency runtime detected; merge PPT dependencies into that deployment instead of replacing its configuration.');
}
// Offline runtime packages are installed into the image. A new isolated venv would hide them.
const values = {
  AGENT_SKILLS_ENABLED:'true', SKILL_SCRIPT_EXECUTION_ENABLED:'true',
  SANDBOX_PROVIDER:'docker', SANDBOX_COMMANDS_ENABLED:'true', SANDBOX_FILE_WRITE_ENABLED:'true',
  SANDBOX_IMAGE:image, SANDBOX_BASH_ENABLED:'true',
  SANDBOX_DEPENDENCIES_ENABLED:'false', SANDBOX_NETWORK_MODE:'none',
};
console.log(JSON.stringify({mode,changes:values}, null, 2));
if (mode === '--apply') {
  const backup = `${envFile}.before-ppt-${Date.now()}`;
  const metadata = await stat(envFile);
  const seen = new Set();
  const lines = before.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !Object.hasOwn(values, match[1])) return [line];
    if (seen.has(match[1])) return [];
    seen.add(match[1]);
    return [`${match[1]}=${values[match[1]]}`];
  });
  for (const [key,value] of Object.entries(values)) if (!seen.has(key)) lines.push(`${key}=${value}`);
  const after = lines.join('\n').replace(/\n*$/, '\n');
  // Preserve ownership/permissions and write atomically; never print existing secrets.
  await copyFile(envFile,backup);
  await chmod(backup,metadata.mode & 0o777);
  await chown(backup,metadata.uid,metadata.gid);
  const temporary = join(dirname(envFile), `.ppt-env-${process.pid}-${Date.now()}`);
  try {
    await writeFile(temporary,after,{flag:'wx',mode:metadata.mode & 0o777});
    await chown(temporary,metadata.uid,metadata.gid);
    if (await readFile(envFile,'utf8') !== before) throw new Error('Environment changed concurrently; not overwritten');
    await rename(temporary,envFile);
  } finally { await unlink(temporary).catch(() => {}); }
  console.log(`Environment updated. Backup: ${backup}`);
}
