import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPool } from '../src/mastra/auth/db';

const directory = join(process.cwd(), 'migrations');
const pool = getPool();
const connection = await pool.connect();
try {
  await connection.query('BEGIN');
  await connection.query(`CREATE TABLE IF NOT EXISTS app_schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  for (const file of (await readdir(directory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) {
    const already = await connection.query('SELECT 1 FROM app_schema_migrations WHERE name = $1', [file]);
    if (already.rowCount) continue;
    await connection.query(await readFile(join(directory, file), 'utf8'));
    await connection.query('INSERT INTO app_schema_migrations(name) VALUES($1)', [file]);
    console.log(`Applied ${file}`);
  }
  await connection.query('COMMIT');
} catch (error) {
  await connection.query('ROLLBACK');
  throw error;
} finally {
  connection.release();
  await pool.end();
}
