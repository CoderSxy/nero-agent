import { maintainObservability } from '../src/mastra/observability/maintenance';
// Hard deadline includes pool initialization and schema/partition maintenance.
const deadline = setTimeout(() => { console.error('Observability maintenance timed out'); process.exit(1); }, 60_000);
try {
  const result = await maintainObservability();
  console.log(JSON.stringify({ status: 'complete', tables: result }));
} finally { clearTimeout(deadline); }
