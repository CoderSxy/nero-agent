import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { resolve } from 'node:path';
import { loadMigrations, applyMigrations, checkMigrations } from '../src/mastra/storage/migrations';
import { assertStorageReady } from '../src/mastra/storage/readiness';
import { createStorageRuntime } from '../src/mastra/observability/runtime';
import { maintainObservability } from '../src/mastra/observability/maintenance';

const appUrl = process.env.RECOVERY_TEST_DATABASE_URL;
const obsUrl = process.env.RECOVERY_TEST_OBSERVABILITY_URL;
// Dedicated throwaway databases only; never falls back to DATABASE_URL.
test('real PostgreSQL: empty schema, missing 015, repair, repeated init, trace write, maintenance and close',
  { skip: !appUrl || !obsUrl, timeout: 60_000 }, async () => {
  for (const url of [appUrl!, obsUrl!]) assert.match(new URL(url).pathname, /_recovery_test$/);
  const pool = new Pool({ connectionString: appUrl!, max: 2 });
  const connection = await pool.connect();
  let runtime: ReturnType<typeof createStorageRuntime> | undefined;
  const obsPool = new Pool({ connectionString: obsUrl!, max: 1 });
  try {
    const migrations = await loadMigrations(resolve('migrations'));
    await assert.rejects(assertStorageReady(connection));
    // The runner must roll back an incomplete release, then simulate the actual pre-015 snapshot.
    await assert.rejects(applyMigrations(connection, migrations.slice(0, -1)), /artifact|产物/);
    for (const m of migrations.slice(0, -1)) await connection.query(m.sql);
    await connection.query('CREATE TABLE IF NOT EXISTS app_schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
    for (const m of migrations.slice(0, -1)) await connection.query('INSERT INTO app_schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING', [m.name]);
    await assert.rejects(assertStorageReady(connection), /015/);
    await assert.rejects(checkMigrations(connection, migrations), /015/);
    assert.deepEqual(await applyMigrations(connection, migrations), ['015_agent_turn_artifacts.sql']);
    await checkMigrations(connection, migrations);
    await assertStorageReady(connection);
    assert.deepEqual(await applyMigrations(connection, migrations), []);
    runtime = createStorageRuntime({ DATABASE_URL: appUrl!, OBSERVABILITY_STORAGE: 'postgres',
      OBSERVABILITY_DATABASE_URL: obsUrl!, OBSERVABILITY_SAMPLE_RATIO: '1' });
    await runtime.storage.init();
    await runtime.storage.init();
    const exporter = runtime.config.exporters![0];
    await exporter.init?.({ mastra: { getStorage: () => runtime!.storage } as any });
    const now = new Date();
    exporter.onTracingEvent?.({ type: 'span_ended', exportedSpan: {
      traceId: 'recovery-trace', id: 'recovery-span', name: 'controlled-recovery-check', type: 'generic',
      startTime: now, endTime: now, isEvent: false, attributes: {}, metadata: {},
    } } as any);
    await exporter.flush();
    await exporter.shutdown();
    const { rows } = await obsPool.query('SELECT count(*)::int AS count FROM nero_observability.mastra_span_events');
    assert.equal(rows[0].count, 1);
    const result = await maintainObservability({ DATABASE_URL: appUrl!, OBSERVABILITY_STORAGE: 'postgres', OBSERVABILITY_DATABASE_URL: obsUrl! });
    assert.equal(result.length, 5);
  } finally {
    await runtime?.storage.close();
    connection.release(); await pool.end(); await obsPool.end();
  }
});
