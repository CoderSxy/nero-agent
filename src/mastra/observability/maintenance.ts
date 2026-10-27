import { Pool } from 'pg';
import { ObservabilityStoragePostgresVNext } from '@mastra/pg';
import { observabilitySettings } from './runtime';

/** Dedicated job: never imports the application entry or starts reconcilers. */
export async function maintainObservability(env: Record<string, string | undefined> = process.env) {
  const settings = observabilitySettings(env);
  if (settings.mode === 'off') return [];
  const pool = new Pool({ connectionString: settings.url!, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 10_000, lock_timeout: 2000 });
  try {
    const storage = new ObservabilityStoragePostgresVNext({ pool, schemaName: 'nero_observability',
      partitioning: { mode: 'native', futureDays: 14 } });
    // init extends daily partitions; no application/agent initialization.
    await storage.init();
    const policy = { maxAge: settings.days * 86_400_000 };
    return await storage.prune(Object.fromEntries(
      ['spans', 'metrics', 'logs', 'scores', 'feedback'].map(key => [key, policy]),
    ), { maxBatches: 2, pauseMs: 100, signal: AbortSignal.timeout(45_000) });
  } finally { await pool.end(); }
}
