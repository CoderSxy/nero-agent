import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import test from 'node:test';

async function fixture(run: (dir: string, path: string, initial: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-deploy-test-'));
  try {
    for (const name of ['store', 'imports', 'workspace']) await mkdir(join(dir, name));
    const path = join(dir, '.env');
    const initial = `DATABASE_URL=postgres://placeholder\nMODEL_TOKEN="keep this secret"\nSKILLS_STORAGE_ROOT=${dir}/store\nSKILLS_IMPORT_TEMP_ROOT=${dir}/imports\nWORKSPACE_ROOT=${dir}/workspace\n`;
    await writeFile(path, initial, { mode: 0o640 });
    await run(dir, path, initial);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function configure(path: string, mode = '--apply') {
  return spawnSync(process.execPath, [resolve('scripts/ppt-deploy/configure-runtime.mjs'), path,
    'nero-ppt@sha256:' + 'a'.repeat(64), mode], { encoding: 'utf8' });
}

test('PPT runtime config cannot bypass host quota or change .env on failed preflight', async () => {
  await fixture(async (dir, path, initial) => {
    const result = configure(path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /quota/);
    assert.equal(await readFile(path, 'utf8'), initial);
    assert.equal((await readdir(dir)).filter(name => name.includes('before-ppt')).length, 0);
  });
});
test('PPT runtime check is read-only; apply preserves credentials, permissions and exact backup', async () => {
  await fixture(async (dir, path, initial) => {
    initial += 'WORKSPACE_HOST_QUOTA_VERIFIED=true\n';
    await writeFile(path, initial);
    assert.equal(configure(path, '--check').status, 0);
    assert.equal(await readFile(path, 'utf8'), initial);
    const result = configure(path);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('keep this secret'));
    assert.equal(parseEnv(await readFile(path, 'utf8')).MODEL_TOKEN, 'keep this secret');
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    const backups = (await readdir(dir)).filter(name => name.startsWith('.env.before-ppt-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(dir, backups[0]), 'utf8'), initial);
  });
});
test('PPT offline setup refuses to replace an existing online execution deployment', async () => {
  await fixture(async (_dir, path, initial) => {
    initial += 'WORKSPACE_HOST_QUOTA_VERIFIED=true\nSANDBOX_COMMANDS_ENABLED=true\nSANDBOX_NETWORK_MODE=public-http\n';
    await writeFile(path, initial);
    assert.notEqual(configure(path).status, 0);
    assert.equal(await readFile(path, 'utf8'), initial);
  });
});
