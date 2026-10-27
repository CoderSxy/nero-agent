import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('application entry never loads embedded DuckDB during startup', async () => {
  const source = await readFile('src/mastra/index.ts', 'utf8');
  assert.doesNotMatch(source, /DuckDBStore|@mastra\/duckdb/);
  assert.ok(source.indexOf('await assertStorageReady(') < source.indexOf('new Mastra('));
});

test('observability defaults to no persistence and rejects accidental shared database', async () => {
  const { observabilitySettings, createStorageRuntime } = await import('../src/mastra/observability/runtime');
  const env = { DATABASE_URL: 'postgres://app:secret@localhost:5432/app' };
  assert.equal(observabilitySettings(env).mode, 'off');
  for (const config of [
    { OBSERVABILITY_STORAGE: 'duckdb' },
    { OBSERVABILITY_STORAGE: 'postgres' },
    { OBSERVABILITY_STORAGE: 'postgres', OBSERVABILITY_DATABASE_URL: 'postgresql://other:secret@localhost/app' },
    { OBSERVABILITY_SAMPLE_RATIO: 'NaN' },
    { OBSERVABILITY_SAMPLE_RATIO: '1.1' },
    { OBSERVABILITY_RETENTION_DAYS: '0' },
  ]) assert.throws(() => observabilitySettings({ ...env, ...config }));
  const runtime = createStorageRuntime(env);
  assert.ok(runtime.observability, 'runtime must construct the registry, not only return unchecked instance config');
  assert.equal(runtime.observability.listInstances().size, 0);
  assert.equal(runtime.config.sampling?.type, 'never');
  assert.equal(runtime.config.exporters?.length, 0);
  assert.equal(runtime.config.logging?.enabled, false);
  await runtime.storage.close();
});

test('payload limiter discards tool bodies, bounds wide metadata and handles cycles without changing trace IDs', async () => {
  const { MetadataOnlyProcessor } = await import('../src/mastra/observability/runtime');
  const cycle: any = {}; cycle.self = cycle;
  const span: any = { traceId: 'trace', spanId: 'span', input: 'x'.repeat(1_000_000), output: cycle,
    requestContext: cycle, metadata: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [i, 'x'.repeat(9000)])),
    attributes: cycle, errorInfo: { message: 'x'.repeat(9000) } };
  new MetadataOnlyProcessor().process(span);
  assert.equal(span.input, undefined); assert.equal(span.output, undefined);
  assert.equal(span.requestContext, undefined); assert.equal(span.traceId, 'trace');
  assert.ok(Buffer.byteLength(JSON.stringify(span)) < 16384);
});

function client(applied: string[] = [], tables = true, fail = false) {
  const calls: string[] = [];
  return { calls, async query(sql: string, args?: unknown[]) {
    calls.push(sql);
    if (sql.includes('SELECT name FROM app_schema_migrations')) return { rows: applied.map(name => ({ name })) };
    if (sql.includes('to_regclass')) return { rows: [{ present: tables }] };
    if (fail && sql === 'CREATE TEST') throw new Error('test SQL failure');
    return { rows: [] };
  } };
}

test('migration check is read-only and fails missing names and artifact tables', async () => {
  const { checkMigrations } = await import('../src/mastra/storage/migrations');
  const sql = [{ name: '015_agent_turn_artifacts.sql', sql: 'CREATE TEST' }];
  const c = client();
  await assert.rejects(checkMigrations(c, sql), /015/);
  assert.ok(c.calls.every(sql => !/^(CREATE|BEGIN|INSERT|ALTER)/.test(sql)));
  await assert.rejects(checkMigrations(client([sql[0].name], false), sql), /artifact|产物/);
  await assert.rejects(checkMigrations(client([sql[0].name, '999_unknown.sql']), sql), /999/);
  await checkMigrations(client([sql[0].name]), sql);
});

test('migration batch serializes concurrent deploys and rolls back without reporting committed files', async () => {
  const { applyMigrations } = await import('../src/mastra/storage/migrations');
  const migrations = [{ name: '015_agent_turn_artifacts.sql', sql: 'CREATE TEST' }];
  const c = client([], true, true);
  await assert.rejects(applyMigrations(c, migrations), /test SQL failure/);
  assert.equal(c.calls.at(-1), 'ROLLBACK');
  assert.ok(!c.calls.includes('COMMIT'));
  assert.ok(c.calls.findIndex(sql => sql.includes('pg_advisory_xact_lock')) < c.calls.indexOf('CREATE TEST'));
  const ok = client();
  assert.deepEqual(await applyMigrations(ok, migrations), [migrations[0].name]);
  assert.equal(ok.calls.at(-1), 'COMMIT');
});

test('shared command queue honors SANDBOX_MAX_CONCURRENT across threads', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = `import { commandQueue } from './src/mastra/sandbox/execution-queue.ts';
    let active=0, peak=0;
    await Promise.all([1,2,3].map(i => commandQueue.run('u', String(i), async () => {
      active++; peak=Math.max(peak, active); await new Promise(r=>setTimeout(r,10)); active--;
    })));
    if (peak !== 1) throw new Error('peak='+peak);`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: { ...process.env, SANDBOX_MAX_CONCURRENT: '1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('slow observability storage retains at most 128 ended spans and one batch in flight', async () => {
  const { createStorageRuntime } = await import('../src/mastra/observability/runtime');
  const runtime = createStorageRuntime({ DATABASE_URL: 'postgres://test@localhost/app',
    OBSERVABILITY_STORAGE: 'postgres', OBSERVABILITY_DATABASE_URL: 'postgres://test@localhost/obs' });
  const exporter = runtime.config.exporters![0];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0, peak = 0, written = 0;
  const store = { observabilityStrategy: { preferred: 'insert-only', supported: ['insert-only'] },
    async batchCreateSpans({ records }: any) {
      active++; peak = Math.max(peak, active); written += records.length;
      await gate; active--;
    } };
  const tasks: any[] = [];
  try {
    await exporter.init?.({ mastra: { getStorage: () => ({ getStore: async () => store }) } as any });
    for (let i = 0; i < 640; i++) tasks.push(exporter.onTracingEvent?.({ type: 'span_ended', exportedSpan: {
      id: `s${i}`, traceId: 't', name: 'bounded', type: 'generic', isEvent: false,
      startTime: new Date(), endTime: new Date(), attributes: {}, metadata: {},
    } } as any));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(peak <= 1, `pending writes=${peak}`);
  } finally {
    release(); await Promise.all(tasks); await exporter.flush(); await exporter.shutdown(); await runtime.storage.close();
  }
  assert.ok(written <= 128, `retained spans=${written}`);
  assert.ok(written > 0);
});
