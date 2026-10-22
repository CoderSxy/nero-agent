import type { Pool } from 'pg';
import {
  redactHealthReport,
  type SkillHealthRepository,
  type SkillHealthResource,
  type SkillStorageHealth,
  type StoredSkillHealth,
} from './health';

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;

export type { SkillHealthRepository };

export function createSkillHealthRepository(db: Pool | { query: Query }): SkillHealthRepository {
  const query = db.query.bind(db) as Query;
  return {
    async upsert(row) {
      const safe = redactHealthReport(row);
      await query(
        `INSERT INTO app_skill_health (
           skill_id, version, manifest_hash, status, safe_code, resource_count, missing_count,
           corrupt_count, diagnostics, checking_started_at, checked_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, now())
         ON CONFLICT (skill_id, version, manifest_hash) DO UPDATE SET
           status = EXCLUDED.status,
           safe_code = EXCLUDED.safe_code,
           resource_count = EXCLUDED.resource_count,
           missing_count = EXCLUDED.missing_count,
           corrupt_count = EXCLUDED.corrupt_count,
           diagnostics = EXCLUDED.diagnostics,
           checking_started_at = EXCLUDED.checking_started_at,
           checked_at = EXCLUDED.checked_at,
           updated_at = now()`,
        [
          safe.skillId,
          safe.version,
          safe.manifestHash,
          safe.status,
          safe.safeCode,
          safe.resourceCount,
          safe.missingCount,
          safe.corruptCount,
          JSON.stringify({ resources: safe.resources ?? [] }),
          row.checkingStartedAt,
          safe.checkedAt,
        ],
      );
    },
    async get(skillId, version, manifestHash) {
      const result = await query(
        `SELECT skill_id, version, manifest_hash, status, safe_code, resource_count, missing_count,
                corrupt_count, diagnostics, checking_started_at, checked_at
         FROM app_skill_health
         WHERE skill_id = $1 AND version = $2 AND manifest_hash = $3`,
        [skillId, version, manifestHash],
      );
      const row = result.rows[0];
      if (!row) return null;
      return rowFrom(row);
    },
  };
}

export function createMemorySkillHealthRepository(): SkillHealthRepository {
  const rows = new Map<string, StoredSkillHealth>();
  const key = (skillId: string, version: number, manifestHash: string) => `${skillId}\0${version}\0${manifestHash}`;
  return {
    async upsert(row) {
      rows.set(key(row.skillId, row.version, row.manifestHash), redactHealthReport({ ...row }));
    },
    async get(skillId, version, manifestHash) {
      return rows.get(key(skillId, version, manifestHash)) ?? null;
    },
  };
}

function rowFrom(row: Record<string, unknown>): StoredSkillHealth {
  const diagnostics = row.diagnostics;
  let parsed: unknown = diagnostics;
  if (typeof diagnostics === 'string') {
    try { parsed = JSON.parse(diagnostics); } catch { parsed = {}; }
  }
  const resources = parsed && typeof parsed === 'object' && Array.isArray((parsed as { resources?: unknown }).resources)
    ? (parsed as { resources: SkillHealthResource[] }).resources
    : [];
  return redactHealthReport({
    skillId: String(row.skill_id),
    version: Number(row.version),
    manifestHash: String(row.manifest_hash),
    status: String(row.status) as SkillStorageHealth,
    checkedAt: row.checked_at ? new Date(String(row.checked_at)).toISOString() : null,
    checkingStartedAt: row.checking_started_at ? new Date(String(row.checking_started_at)).toISOString() : null,
    safeCode: row.safe_code == null ? null : String(row.safe_code),
    resourceCount: Number(row.resource_count ?? 0),
    missingCount: Number(row.missing_count ?? 0),
    corruptCount: Number(row.corrupt_count ?? 0),
    resources,
  });
}
