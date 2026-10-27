export interface SqlClient {
  query(sql: string, values?: any[]): Promise<{ rows: any[] }>;
}
export const ARTIFACT_MIGRATION = '015_agent_turn_artifacts.sql';
export async function assertArtifactTables(client: SqlClient): Promise<void> {
  const { rows } = await client.query(`SELECT
    to_regclass('public.app_agent_artifact_runs') IS NOT NULL AND
    to_regclass('public.app_agent_run_artifacts') IS NOT NULL AND
    to_regclass('public.app_agent_artifact_operations') IS NOT NULL AS present`);
  if (!rows[0]?.present) throw new Error('产物 artifact schema 不完整，请先执行发布包 migrate.mjs，再运行 --check');
}
export async function assertStorageReady(client: SqlClient): Promise<void> {
  try {
    const result = await client.query('SELECT name FROM app_schema_migrations WHERE name = $1', [ARTIFACT_MIGRATION]);
    if (!result.rows.length) throw new Error(`缺少 ${ARTIFACT_MIGRATION}`);
    await assertArtifactTables(client);
  } catch (error) {
    // Do not log database URLs / driver errors containing connection details.
    throw new Error('数据库未就绪：需要 015 迁移和完整产物表；请先备份，执行 migrate.mjs 与 --check', { cause: error });
  }
}
