import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { getPool } from '../src/mastra/auth/db';
import { LibSQLStore } from '@mastra/libsql';

const sourcePath = process.argv[2] || 'src/mastra/public/mastra.db';
const adminEmail = process.argv[3] || 'admin@nero.local';
if (!existsSync(sourcePath)) throw new Error(`旧数据库文件不存在: ${sourcePath}`);
const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
const oldStorage = new LibSQLStore({ id: 'old-libsql', url: `file:${sourcePath}` });
const oldMemory = await oldStorage.getStore('memory');
const connection = await getPool().connect();
try {
  const owner = await connection.query<{ id: string }>(
    `SELECT u.id FROM app_users u JOIN app_user_roles ur ON ur.user_id = u.id
     JOIN app_roles r ON r.id = ur.role_id WHERE u.email = $1 AND r.code = 'admin'`,
    [adminEmail.toLowerCase()]);
  if (!owner.rows[0]) throw new Error(`找不到管理员账号: ${adminEmail}`);
  const ownerId = owner.rows[0].id;
  await connection.query('BEGIN');
  for (const table of ['mastra_threads', 'mastra_messages', 'mastra_observational_memory', 'mastra_thread_state']) {
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    const pgColumns = await connection.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]);
    const types = new Map(pgColumns.rows.map(column => [column.column_name, column.data_type]));
    if (types.size === 0) throw new Error(`PG 中缺少 ${table}，请先启动 Mastra 以初始化存储表`);
    for (const raw of rows) {
      const row = { ...raw };
      if ('resourceId' in row) row.resourceId = ownerId;
      for (const [key, value] of Object.entries(row)) {
        if (types.get(key) === 'boolean' && value !== null) row[key] = Boolean(value);
        if (types.get(key) === 'jsonb' && value !== null) {
          if (value instanceof Uint8Array && table === 'mastra_threads' && key === 'metadata') {
            const thread = await oldMemory.getThreadById({ threadId: String(row.id) });
            row[key] = JSON.stringify(thread?.metadata ?? {});
          } else row[key] = JSON.stringify(JSON.parse(String(value)));
        }
        if (value && types.has(`${key}Z`)) row[`${key}Z`] = value;
      }
      const columns = Object.keys(row).filter(column => types.has(column));
      const parameters = columns.map(column => row[column]);
      const placeholders = columns.map((column, index) => `$${index + 1}${types.get(column) === 'jsonb' ? '::jsonb' : ''}`);
      await connection.query(
        `INSERT INTO ${table} (${columns.map(column => `"${column}"`).join(', ')})
         VALUES (${placeholders.join(', ')}) ON CONFLICT DO NOTHING`, parameters);
    }
    console.log(`Imported ${rows.length} rows from ${table}`);
  }
  await connection.query('COMMIT');
} catch (error) {
  await connection.query('ROLLBACK');
  throw error;
} finally {
  sqlite.close(); connection.release(); await getPool().end();
}
