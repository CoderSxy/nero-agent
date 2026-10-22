import type { RequestContext } from '@mastra/core/request-context';
import { readBoundServerExecutionId } from '../../skills/execution-context';

type FileProof = { runId: string; id: string; etag: string; read: () => Promise<{ etag: string }> };
const proofs = new WeakMap<object, FileProof[]>();
/** Only the authenticated write tool can register a proof; client context strings cannot. */
export function recordWrittenFile(context: RequestContext, id: string, etag: string, read: FileProof['read']) {
  const runId = readBoundServerExecutionId(context);
  if (!runId) return;
  const current = (proofs.get(context) ?? []).filter(p => p.runId === runId && p.id !== id);
  current.push({ runId, id, etag, read });
  proofs.set(context, current);
}
export async function verifyWrittenFiles(context?: RequestContext): Promise<Array<{ id: string; ok: boolean }>> {
  if (!context) return [];
  const runId = readBoundServerExecutionId(context);
  return Promise.all((proofs.get(context) ?? []).filter(p => p.runId === runId).map(async p => {
    try { return { id: p.id, ok: (await p.read()).etag === p.etag }; }
    catch { return { id: p.id, ok: false }; }
  }));
}
