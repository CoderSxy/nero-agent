import type { Pool, PoolClient } from 'pg';
import { getPool } from '../auth/db';
import type { ModelCapabilityReport } from './capabilities';
import type { ModelScope } from './types';

type Queryable = Pick<Pool | PoolClient, 'query'>;

type Row = {
  connection_fingerprint: string;
  probe_version: string;
  tool_calling: ModelCapabilityReport['toolCalling'];
  forced_tool_choice: ModelCapabilityReport['forcedToolChoice'];
  json_schema: ModelCapabilityReport['jsonSchema'];
  safe_report: { safeReason?: string | null };
  checked_at: Date;
};

export async function saveCapabilityReport(
  scope: ModelScope,
  modelId: string,
  report: ModelCapabilityReport,
  db: Queryable = getPool(),
): Promise<void> {
  const column = scope === 'public' ? 'public_model_id' : 'private_model_id';
  await db.query(
    `INSERT INTO app_model_capability_checks (
       ${column}, connection_fingerprint, probe_version, tool_calling, forced_tool_choice, json_schema, safe_report, checked_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      modelId,
      report.fingerprint,
      report.probeVersion,
      report.toolCalling,
      report.forcedToolChoice,
      report.jsonSchema,
      JSON.stringify({ safeReason: report.safeReason }),
      report.checkedAt ?? new Date().toISOString(),
    ],
  );
}

export async function latestCapabilityReport(
  scope: ModelScope,
  modelId: string,
  db: Queryable = getPool(),
): Promise<ModelCapabilityReport | null> {
  const column = scope === 'public' ? 'public_model_id' : 'private_model_id';
  const result = await db.query<Row>(
    `SELECT connection_fingerprint, probe_version, tool_calling, forced_tool_choice, json_schema, safe_report, checked_at
     FROM app_model_capability_checks
     WHERE ${column} = $1
     ORDER BY checked_at DESC
     LIMIT 1`,
    [modelId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    toolCalling: row.tool_calling,
    forcedToolChoice: row.forced_tool_choice,
    jsonSchema: row.json_schema,
    checkedAt: new Date(row.checked_at).toISOString(),
    safeReason: row.safe_report?.safeReason ?? null,
    probeVersion: row.probe_version,
    fingerprint: row.connection_fingerprint,
  };
}

export async function deleteCapabilityReports(
  scope: ModelScope,
  modelId: string,
  db: Queryable = getPool(),
): Promise<void> {
  const column = scope === 'public' ? 'public_model_id' : 'private_model_id';
  await db.query(`DELETE FROM app_model_capability_checks WHERE ${column} = $1`, [modelId]);
}
