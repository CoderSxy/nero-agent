import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getPool } from '../src/mastra/auth/db';

function resolveSafeTestDatabaseUrl(): { ok: true } | { ok: false; reason: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL unset; task quality schema tests skipped' };
  try {
    const parsed = new URL(raw);
    const hostOk = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    const portOk = parsed.port === '5433';
    const dbOk = parsed.pathname.replace(/^\//, '') === 'nero_agent';
    if (!hostOk || !portOk || !dbOk) {
      return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL is not localhost:5433/nero_agent; refusing task quality schema tests' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL is not a valid URL' };
  }
}

const safeDb = resolveSafeTestDatabaseUrl();

async function expectSqlError(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  code: string,
  sql: string,
  params: unknown[],
): Promise<void> {
  await client.query('SAVEPOINT task_quality_expected');
  try {
    await assert.rejects(() => client.query(sql, params), (error: { code?: string }) => error.code === code);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT task_quality_expected');
  }
}

test('phase-one quality tables enforce foreign keys, uniqueness, and owner updates', { skip: safeDb.ok ? false : safeDb.reason }, async () => {
  const sql = await readFile(new URL('../migrations/014_agent_phase_one_quality.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /INSERT\s+INTO/i);
  assert.doesNotMatch(sql, /api_key/i);
  const pool = getPool();
  const client = await pool.connect();
  const suffix = randomUUID().slice(0, 8);
  try {
    await client.query('BEGIN');
    const present = await client.query(`SELECT to_regclass('public.app_agent_run_controls') AS name`);
    if (!present.rows[0].name) await client.query(sql);

    const userA = randomUUID();
    const userB = randomUUID();
    await client.query(
      `INSERT INTO app_users (id, email, display_name, password_hash)
       VALUES ($1, $2, 'Schema A', 'test-hash'), ($3, $4, 'Schema B', 'test-hash')`,
      [userA, `tq-a-${suffix}@example.test`, userB, `tq-b-${suffix}@example.test`],
    );
    const publicModel = await client.query<{ id: string; credential_revision: number }>(
      `INSERT INTO app_public_models (display_name, provider_id, model_id, base_url, api_key_ciphertext)
       VALUES ($1, 'openai', 'gpt-test', 'https://example.test/v1', 'ciphertext')
       RETURNING id, credential_revision`,
      [`public-${suffix}`],
    );
    const privateModel = await client.query<{ id: string; credential_revision: number }>(
      `INSERT INTO app_private_models (user_id, display_name, provider_id, model_id, base_url, api_key_ciphertext)
       VALUES ($1, $2, 'openai', 'gpt-test', 'https://example.test/v1', 'ciphertext')
       RETURNING id, credential_revision`,
      [userA, `private-${suffix}`],
    );
    assert.equal(publicModel.rows[0].credential_revision, 1);
    assert.equal(privateModel.rows[0].credential_revision, 1);

    await client.query(
      `INSERT INTO app_skills (id, canonical_name, owner_user_id, visibility, enabled, version_seq)
       VALUES ($1, $2, $3, 'private', false, 1)`,
      [randomUUID(), `skill-${suffix}`, userA],
    );
    const skill = await client.query<{ id: string }>(`SELECT id FROM app_skills WHERE canonical_name = $1`, [`skill-${suffix}`]);
    await client.query(
      `INSERT INTO app_skill_versions (skill_id, version, state, description, skill_md, manifest_hash, created_by)
       VALUES ($1, 1, 'draft', 'diag', '# skill', $2, $3)`,
      [skill.rows[0].id, `hash-${suffix}`, userA],
    );
    await client.query(
      `INSERT INTO app_skill_health (skill_id, version, manifest_hash, status, checking_started_at)
       VALUES ($1, 1, $2, 'checking', now())`,
      [skill.rows[0].id, `hash-${suffix}`],
    );
    await expectSqlError(client, '23503',
      `INSERT INTO app_skill_health (skill_id, version, manifest_hash, status)
       VALUES ($1, 9, 'missing', 'healthy')`,
      [skill.rows[0].id]);

    await client.query(
      `INSERT INTO app_model_capability_checks (
         public_model_id, connection_fingerprint, probe_version, tool_calling, forced_tool_choice, json_schema, safe_report
       ) VALUES ($1, 'fp', 'v1', 'unknown', 'unknown', 'unknown', '{}')`,
      [publicModel.rows[0].id],
    );
    await expectSqlError(client, '23514',
      `INSERT INTO app_model_capability_checks (
         public_model_id, private_model_id, connection_fingerprint, probe_version,
         tool_calling, forced_tool_choice, json_schema, safe_report
       ) VALUES ($1, $2, 'both', 'v1', 'unknown', 'unknown', 'unknown', '{}')`,
      [publicModel.rows[0].id, privateModel.rows[0].id]);
    await expectSqlError(client, '23503',
      `INSERT INTO app_model_capability_checks (
         public_model_id, connection_fingerprint, probe_version, tool_calling, forced_tool_choice, json_schema, safe_report
       ) VALUES ($1, 'orphan', 'v1', 'unknown', 'unknown', 'unknown', '{}')`,
      [randomUUID()]);

    const runId = `run-${suffix}`;
    await client.query(
      `INSERT INTO app_agent_run_controls (
         run_id, user_id, thread_id, contract, profile, mode, status
       ) VALUES ($1, $2, 'thread-1', '{"version":1}', 'general', 'observe', 'active')`,
      [runId, userA],
    );
    await client.query(
      `INSERT INTO app_agent_run_operations (run_id, operation_id, kind, status, started_at)
       VALUES ($1, 'op-1', 'main-model', 'reserved', now())`,
      [runId],
    );
    await expectSqlError(client, '23505',
      `INSERT INTO app_agent_run_operations (run_id, operation_id, kind, status)
       VALUES ($1, 'op-1', 'tool', 'reserved')`,
      [runId]);
    await expectSqlError(client, '42501',
      `SELECT app_update_agent_run_status($1, $2, 'completed')`,
      [runId, userB]);
    const owned = await client.query(`SELECT app_update_agent_run_status($1, $2, 'completed')`, [runId, userA]);
    assert.equal(owned.rows.length, 1);
    const status = await client.query<{ status: string }>(`SELECT status FROM app_agent_run_controls WHERE run_id = $1`, [runId]);
    assert.equal(status.rows[0].status, 'completed');
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'app_agent_run_operations'`,
    );
    const names = columns.rows.map(row => row.column_name);
    assert.equal(names.includes('arguments'), false);
    assert.equal(names.includes('prompt'), false);
    assert.equal(names.includes('api_key'), false);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
