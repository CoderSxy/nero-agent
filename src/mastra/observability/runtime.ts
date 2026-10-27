import { Pool } from 'pg';
import { BoundedStorageExporter } from './bounded-exporter';
import { PostgresStore, PostgresStoreVNext } from '@mastra/pg';
import { Observability, SensitiveDataFilter, SamplingStrategyType } from '@mastra/observability';
import type { ObservabilityInstanceConfig } from '@mastra/observability';
import type { AnySpan, SpanOutputProcessor } from '@mastra/core/observability';

type Environment = Record<string, string | undefined>;
function databaseTarget(value: string): string {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Observability requires PostgreSQL');
  return `${url.hostname.toLowerCase()}:${url.port || '5432'}/${decodeURIComponent(url.pathname)}`;
}
export function observabilitySettings(env: Environment = process.env) {
  const mode = env.OBSERVABILITY_STORAGE ?? 'off';
  if (mode !== 'off' && mode !== 'postgres') throw new Error('OBSERVABILITY_STORAGE must be off or postgres');
  const ratio = Number(env.OBSERVABILITY_SAMPLE_RATIO ?? '0.1');
  const days = Number(env.OBSERVABILITY_RETENTION_DAYS ?? '7');
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error('OBSERVABILITY_SAMPLE_RATIO must be 0..1');
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('OBSERVABILITY_RETENTION_DAYS must be 1..90');
  const url = env.OBSERVABILITY_DATABASE_URL;
  if (mode === 'postgres') {
    if (!url || !env.DATABASE_URL) throw new Error('Independent OBSERVABILITY_DATABASE_URL and DATABASE_URL are required');
    if (databaseTarget(url) === databaseTarget(env.DATABASE_URL)) throw new Error('Observability must not share the application database');
  }
  return { mode, ratio, days, url };
}

/** Never persist prompts, tool bodies or filesystem contents as a second copy. */
export class MetadataOnlyProcessor implements SpanOutputProcessor {
  name = 'bounded-metadata-only';
  async shutdown(): Promise<void> {}
  process(span: AnySpan): AnySpan {
    span.input = undefined;
    span.output = undefined;
    span.requestContext = undefined;
    let remaining = 6000;
    const seen = new WeakSet<object>();
    function bounded(value: unknown, depth = 0): unknown {
      if (remaining <= 0 || depth > 3) return '[omitted]';
      if (typeof value === 'string') {
        const result = value.slice(0, Math.min(512, Math.floor(remaining / 4)));
        remaining -= Buffer.byteLength(result);
        return result;
      }
      if (value === null || typeof value === 'boolean' || typeof value === 'number') { remaining -= 16; return value; }
      if (typeof value !== 'object') return undefined;
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      if (Array.isArray(value)) return value.slice(0, 8).map(item => bounded(item, depth + 1));
      const result: Record<string, unknown> = Object.create(null);
      let count = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (count++ >= 8 || remaining <= 0) break;
        const boundedKey = key.slice(0, 64);
        remaining -= Buffer.byteLength(boundedKey);
        result[boundedKey] = bounded((value as Record<string, unknown>)[key], depth + 1);
      }
      return result;
    }
    // These payload fields are writable in the installed SpanOutputProcessor contract.
    span.attributes = bounded(span.attributes) as typeof span.attributes;
    span.metadata = bounded(span.metadata) as typeof span.metadata;
    span.errorInfo = bounded(span.errorInfo) as typeof span.errorInfo;
    return span;
  }
}

export function createStorageRuntime(env: Environment = process.env) {
  const settings = observabilitySettings(env);
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL 未配置');
  const primaryPool = new Pool({ connectionString: env.DATABASE_URL, max: 4,
    connectionTimeoutMillis: 10_000, statement_timeout: 30_000, lock_timeout: 5000 });
  const pools = [primaryPool];
  primaryPool.on('error', () => console.error('Application storage idle connection error'));
  const obsPool = settings.mode === 'postgres' ? new Pool({ connectionString: settings.url!, max: 2,
    connectionTimeoutMillis: 5000, statement_timeout: 10_000, lock_timeout: 2000 }) : undefined;
  if (obsPool) {
    pools.push(obsPool);
    obsPool.on('error', () => console.error('Observability idle connection error'));
  }
  const primary = { id: 'mastra-storage', pool: primaryPool };
  const storage = !obsPool ? new PostgresStore(primary) : new PostgresStoreVNext({
    ...primary,
    observability: { pool: obsPool, schemaName: 'nero_observability',
      partitioning: { mode: 'native', futureDays: 14 }, traceQueryTimeoutMs: 5000 },
  });
  // Mastra intentionally does not close caller-provided pools. This runtime owns them.
  const closeStore = storage.close.bind(storage);
  let closing: Promise<void> | undefined;
  storage.close = () => closing ??= (async () => {
    try { await closeStore(); } finally { await Promise.all(pools.map(pool => pool.end())); }
  })();
  const config: Omit<ObservabilityInstanceConfig, 'name'> = {
    serviceName: 'nero-agent',
    sampling: settings.mode === 'off' ? { type: SamplingStrategyType.NEVER }
      : { type: SamplingStrategyType.RATIO, probability: settings.ratio },
    exporters: settings.mode === 'off' ? [] : [new BoundedStorageExporter()],
    logging: { enabled: false },
    includeInternalSpans: false,
    serializationOptions: { maxStringLength: 1024, maxDepth: 4, maxArrayLength: 20, maxObjectKeys: 20 },
    spanOutputProcessors: [new MetadataOnlyProcessor(), new SensitiveDataFilter()],
  };
  // Empty instances disable collection. A named instance with exporters:[] is rejected by Mastra.
  const observability = new Observability(settings.mode === 'off' ? {} : { configs: { default: config } });
  return { storage, config, settings, observability };
}
