// Read-only incident diagnostic. Stop the owning service before opening its DuckDB.
import { createRequire } from 'node:module';
const require = createRequire('/opt/nero-agent/current/mastra/index.mjs');
const { DuckDBInstance } = require('@duckdb/node-api');
const db = await DuckDBInstance.create('/var/lib/nero-agent/mastra.duckdb', {
  access_mode: 'READ_ONLY', memory_limit: '128MB', preserve_insertion_order: 'false', threads: '1',
});
let connection;
try {
  connection = await db.connect();
  const rows = await connection.runAndReadAll(`SELECT name, "spanType", timestamp AS "startedAt", input
    FROM span_events WHERE "threadId" = ?
      AND timestamp >= TIMESTAMP '2026-10-23 15:30:00'
      AND timestamp < TIMESTAMP '2026-10-23 16:00:00'
      AND (name ILIKE '%execute%' OR name ILIKE '%bash%' OR name ILIKE '%script%')
    ORDER BY timestamp LIMIT 20`, ['8e34d9f9-c3af-4c71-998f-245a3b5ca4dd']);
  for (const row of rows.getRowObjectsJson()) {
    let input = row.input;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
    const command = input?.command ?? input?.args?.command ?? input?.input?.command;
    console.log(JSON.stringify({ name: row.name, spanType: row.spanType, startedAt: row.startedAt,
      command: typeof command === 'string' ? command.slice(0, 1800)
        .replace(/(Bearer\s+|(?:password|api[_-]?key|token)\s*[=:]\s*)[^\s]+/gi, '$1[REDACTED]') : null,
      inputKeys: input && typeof input === 'object' ? Object.keys(input) : [],
    }));
  }
  console.log(JSON.stringify({ matchedSpans: rows.getRowObjectsJson().length }));
} finally {
  connection?.closeSync();
  db.closeSync();
}
