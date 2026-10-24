// Prepare a minimal immutable backport; activation and service restart are separate.
// Usage: node patch-skill-search-release.mjs <current-release> <new-release> <payload.json>
import { readFile, writeFile, stat, lstat, rename, chown, chmod, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function patchSkillSearchModule(before, payload) {
  const startMarker = 'function scoreText(haystack, query) {';
  const endMarker = 'function createSkillService(deps) {';
  for (const marker of [startMarker, endMarker, payload.oldDescription]) {
    if (!marker || before.split(marker).length !== 2) throw new Error('Unexpected release marker: ' + marker);
  }
  const start = before.indexOf(startMarker);
  const end = before.indexOf(endMarker);
  if (end <= start || before.slice(start, end).includes('searchTerms(')) throw new Error('Unexpected or already patched helper region');
  if (!payload.replacement.startsWith(startMarker) || !payload.replacement.includes('function searchTerms(')
      || !payload.replacement.includes('function extractSnippet(')) throw new Error('Invalid helper payload');
  const fixed = before.slice(0, start) + payload.replacement + '\n' + before.slice(end);
  return fixed.replace(payload.oldDescription, payload.newDescription);
}

async function main() {
  const [sourceArg, targetArg, payloadArg] = process.argv.slice(2);
  if (!sourceArg || !targetArg || !payloadArg) throw new Error('Three paths required');
  const source = await realpath(sourceArg);
  const target = resolve(targetArg);
  const parent = '/opt/nero-agent/releases';
  if (dirname(source) !== parent || dirname(target) !== parent || source === target) throw new Error('Expected distinct sibling production releases');
  try { await lstat(target); throw new Error('Target already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const relative = 'mastra/mastra.mjs';
  const before = await readFile(join(source, relative), 'utf8');
  const payload = JSON.parse(await readFile(payloadArg, 'utf8'));
  const after = patchSkillSearchModule(before, payload);
  const copied = spawnSync('cp', ['-al', '--', source, target], { stdio: 'inherit' });
  if (copied.status !== 0) throw new Error('Release cloning failed');
  const file = join(target, relative);
  const metadata = await stat(file);
  const temporary = file + '.skill-search-tmp';
  await writeFile(temporary, after, { flag: 'wx', mode: metadata.mode & 0o777 });
  await chown(temporary, metadata.uid, metadata.gid);
  await chmod(temporary, metadata.mode & 0o777);
  await rename(temporary, file);
  if (await readFile(join(source, relative), 'utf8') !== before) throw new Error('Previous release changed unexpectedly');
  if (spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }).status !== 0) throw new Error('Module syntax check failed; release not activated');
  console.log(JSON.stringify({ previous: source, prepared: target,
    beforeSha256: createHash('sha256').update(before).digest('hex'),
    afterSha256: createHash('sha256').update(after).digest('hex') }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
