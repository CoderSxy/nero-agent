import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(run: (dir: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nero-backup-'));
  try {
    const bin = join(dir, 'bin'); await mkdir(bin);
    for (const name of ['id', 'systemctl', 'docker', 'flock']) {
      await writeFile(join(bin, name), `#!/bin/sh
case "$(basename "$0")" in
id) echo 0 ;;
flock) exit 0 ;;
systemctl)
 case "$*" in *MainPID*) echo 0;; *ActiveState*) echo "\${TEST_STATE:-inactive}";; *) echo unit-config;; esac ;;
docker)
 case "$*" in *pg_dump*) test "\${TEST_FAIL:-0}" = 0 || exit 2; echo dump-data;; *pg_restore*) cat >/dev/null; echo toc;; *) echo postgres-identity;; esac ;;
esac
`, { mode: 0o755 });
    }
    await writeFile(join(dir, 'mastra.duckdb'), 'original-db');
    await writeFile(join(dir, 'mastra.duckdb.wal'), 'original-wal');
    await writeFile(join(dir, '.env'), 'SECRET=keep-secret');
    await run(dir, { ...process.env, PATH: `${bin}:${process.env.PATH}`, DUCKDB_PATH: join(dir, 'mastra.duckdb'),
      ENV_FILE: join(dir, '.env'), CURRENT_LINK: join(dir, 'current') });
  } finally { await rm(dir, { force: true, recursive: true }); }
}
function backup(dir: string, env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [resolve('scripts/ops/backup.sh'), join(dir, 'backups', 'run')], { env, encoding: 'utf8' });
}
test('backup refuses running service, leaves originals untouched and never exposes secrets', async () => fixture(async (dir, env) => {
  const result = backup(dir, { ...env, TEST_STATE: 'active' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inactive|stopped|停止/);
  assert.equal(await readFile(join(dir, 'mastra.duckdb'), 'utf8'), 'original-db');
  await assert.rejects(access(join(dir, 'backups/run/COMPLETE')));
}));
test('backup keeps a private verified database/WAL pair, rejects overwrite and marks only success', async () => fixture(async (dir, env) => {
  const result = backup(dir, env);
  assert.equal(result.status, 0, result.stderr);
  const dest = join(dir, 'backups/run');
  assert.equal((await stat(dest)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(dest, 'mastra.duckdb.wal'), 'utf8'), 'original-wal');
  assert.match(await readFile(join(dest, 'SHA256SUMS'), 'utf8'), /mastra.duckdb.wal/);
  await access(join(dest, 'COMPLETE'));
  assert.ok(!result.stdout.includes('keep-secret'));
  assert.notEqual(backup(dir, env).status, 0);
}));
test('failed pg_dump never produces a complete backup', async () => fixture(async (dir, env) => {
  assert.notEqual(backup(dir, { ...env, TEST_FAIL: '1' }).status, 0);
  await assert.rejects(access(join(dir, 'backups/run/COMPLETE')));
}));

test('prepare release refuses migration when backup failed', async () => fixture(async (dir, env) => {
  const release = join(dir, 'release'); await mkdir(release);
  await writeFile(join(release, 'index.mjs'), '// candidate');
  await writeFile(join(release, 'migrate.mjs'), "await import('node:fs/promises').then(fs=>fs.writeFile(process.env.MIGRATION_MARKER, 'executed'))");
  const marker = join(dir, 'migration-called');
  const result = spawnSync('bash', [resolve('scripts/ops/prepare-release.sh'), release, join(dir, 'backup')], {
    env: { ...env, TEST_FAIL: '1', NODE_BIN: process.execPath, MIGRATION_MARKER: marker }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  await assert.rejects(access(marker));
  assert.match(result.stderr, /backup|备份/i);
}));
