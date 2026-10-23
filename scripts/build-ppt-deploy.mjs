import { build } from 'esbuild';
import { mkdir, copyFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname,'..');
const out = join(root,'dist/ppt-skill-deploy');
await mkdir(out,{recursive:true});
for (const [source,name] of [
  ['scripts/skills-import.ts','import.mjs'],
  ['scripts/ppt-deploy/check.ts','check.mjs'],
]) await build({entryPoints:[join(root,source)],outfile:join(out,name),bundle:true,platform:'node',format:'esm',packages:'external'});
for (const file of await readdir(join(root,'scripts/ppt-deploy'))) {
  if (file.endsWith('.ts')) continue;
  await copyFile(join(root,'scripts/ppt-deploy',file),join(out,file));
  await chmod(join(out,file),file.endsWith('.sh')?0o755:0o644);
}
await copyFile(join(root,'sandbox/Dockerfile'),join(out,'Dockerfile.base'));
await copyFile(join(root,'scripts/check-workspace-quota.mjs'),join(out,'check-workspace-quota.mjs'));
await copyFile(join(root,'local-skills/ppt-nero.zip'),join(out,'ppt-nero.zip'));
const sums=[];
for (const file of (await readdir(out)).sort()) {
  if (file==='SHA256SUMS' || file==='node_modules') continue;
  sums.push(`${createHash('sha256').update(await readFile(join(out,file))).digest('hex')}  ${file}`);
}
await writeFile(join(out,'SHA256SUMS'),sums.join('\n')+'\n');
const archive = join(root,'dist/ppt-skill-deploy.tar.gz');
const tar = spawnSync('tar', ['--exclude=node_modules','--exclude=.DS_Store','--exclude=._*',
  '-czf',archive,'-C',out,'.'], { env:{...process.env,COPYFILE_DISABLE:'1'}, stdio:'inherit' });
if (tar.status !== 0) throw new Error('Deployment archive creation failed');
const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive+'.sha256',`${hash}  ppt-skill-deploy.tar.gz\n`);
console.log(`${archive}\nSHA-256: ${hash}`);
