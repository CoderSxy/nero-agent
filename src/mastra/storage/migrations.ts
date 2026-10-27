import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ARTIFACT_MIGRATION, assertArtifactTables, type SqlClient } from './readiness';
export type Migration = { name: string; sql: string };
export async function loadMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  if (!names.includes(ARTIFACT_MIGRATION)) throw new Error(`迁移目录缺少 ${ARTIFACT_MIGRATION}`);
  return Promise.all(names.map(async name => ({ name, sql: await readFile(join(directory, name), 'utf8') })));
}
function diff(applied: string[], migrations: Migration[]) {
  const expected = migrations.map(m => m.name);
  return { missing: expected.filter(name => !applied.includes(name)), unknown: applied.filter(name => !expected.includes(name)) };
}
export async function checkMigrations(client: SqlClient, migrations: Migration[]): Promise<void> {
  const result = await client.query('SELECT name FROM app_schema_migrations ORDER BY name');
  const { missing, unknown } = diff(result.rows.map(row => row.name), migrations);
  if (missing.length || unknown.length) throw new Error(`Migration mismatch: missing=[${missing.join(', ')}], unknown=[${unknown.join(', ')}]`);
  await assertArtifactTables(client);
}
export async function applyMigrations(client: SqlClient, migrations: Migration[]): Promise<string[]> {
  const committed: string[] = [];
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query('SELECT pg_advisory_xact_lock(1784231001)');
    await client.query('CREATE TABLE IF NOT EXISTS app_schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const result = await client.query('SELECT name FROM app_schema_migrations ORDER BY name');
    const { missing, unknown } = diff(result.rows.map(row => row.name), migrations);
    if (unknown.length) throw new Error(`Database has unknown migrations: ${unknown.join(', ')}`);
    for (const migration of migrations) {
      if (!missing.includes(migration.name)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO app_schema_migrations(name) VALUES($1)', [migration.name]);
      committed.push(migration.name);
    }
    await assertArtifactTables(client);
    await client.query('COMMIT');
    return committed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
