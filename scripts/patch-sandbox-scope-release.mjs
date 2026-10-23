// Backport the tested registry SQL fix into a new immutable release directory.
// Usage: node patch-sandbox-scope-release.mjs <current-release> <new-release>
import { readFile, writeFile, stat, lstat, rename, chown, chmod, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg) throw new Error('Two release paths required');
const source = await realpath(sourceArg);
const target = resolve(targetArg);
const parent = '/opt/nero-agent/releases';
if (dirname(source) !== parent || dirname(target) !== parent || source === target) throw new Error('Expected distinct sibling production release paths');
try { await lstat(target); throw new Error('Target already exists'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const relative = 'mastra/mastra.mjs';
const before = await readFile(join(source, relative), 'utf8');
const marker = 'INSERT INTO app_sandbox_instances';
const start = before.indexOf(marker);
if (start < 0 || before.indexOf(marker, start + marker.length) >= 0) throw new Error('Expected exactly one sandbox registry INSERT');
const tail = 'updated_at = now()';
const end = before.indexOf(tail, start) + tail.length;
if (end < start) throw new Error('Registry UPSERT end missing');
const query = before.slice(start, end);
function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw new Error('Expected SQL fragment exactly once: ' + from);
  return text.replace(from, to);
}
let fixed = replaceOnce(query,
  '(user_id, sandbox_id, container_id, status, workspace_root, last_active_at)',
  '(user_id, scope_id, sandbox_id, container_id, status, workspace_root, last_active_at)');
fixed = replaceOnce(fixed,
  'VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))',
  'VALUES ($1, $1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))');
fixed = replaceOnce(fixed, 'sandbox_id = EXCLUDED.sandbox_id,', 'scope_id = EXCLUDED.scope_id,\n         sandbox_id = EXCLUDED.sandbox_id,');
const after = before.slice(0, start) + fixed + before.slice(end);
const copied = spawnSync('cp', ['-al', '--', source, target], { stdio: 'inherit' });
if (copied.status !== 0) throw new Error('Release cloning failed');
const file = join(target, relative);
const metadata = await stat(file);
const temporary = file + '.scope-fix-tmp';
// Atomic replacement breaks the hardlink; the previous release is unchanged.
await writeFile(temporary, after, { flag: 'wx', mode: metadata.mode & 0o777 });
await chown(temporary, metadata.uid, metadata.gid);
await chmod(temporary, metadata.mode & 0o777);
await rename(temporary, file);
if (await readFile(join(source, relative), 'utf8') !== before) throw new Error('Previous release changed unexpectedly');
const checked = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
if (checked.status !== 0) throw new Error('Patched module syntax check failed; release was not activated');
console.log(JSON.stringify({previous:source, prepared:target, module:relative,
  beforeSha256:createHash('sha256').update(before).digest('hex'),
  afterSha256:createHash('sha256').update(after).digest('hex'), query:fixed},null,2));
