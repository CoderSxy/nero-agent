import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { getPool } from '../src/mastra/auth/db';
import { loadMigrations, checkMigrations, applyMigrations } from '../src/mastra/storage/migrations';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) throw new Error('Usage: migrate.mjs [--check]');
// Bundled release resolves beside migrate.mjs; source invocation resolves repository migrations.
let directory = process.env.APP_MIGRATIONS_DIR ?? fileURLToPath(new URL('./migrations', import.meta.url));
if (!process.env.APP_MIGRATIONS_DIR) {
  try { await access(directory); } catch { directory = join(process.cwd(), 'migrations'); }
}
const migrations = await loadMigrations(directory);
const pool = getPool();
try {
  const connection = await pool.connect();
  try {
    await connection.query("SET statement_timeout = '60s'");
    if (args.includes('--check')) { await checkMigrations(connection, migrations); console.log('Migration check passed'); }
    else {
      const committed = await applyMigrations(connection, migrations);
      console.log(`Committed ${committed.length} migrations: ${committed.join(', ')}`);
      await checkMigrations(connection, migrations);
    }
  } finally { connection.release(); }
} finally { await pool.end(); }
