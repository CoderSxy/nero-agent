import type { ArtifactRunIdentity } from './types';
import type { ArtifactRepository } from './repository';

// A transient DB outage cannot persist its own diagnostic. Keep it until settlement
// can write the partial marker; key by server identity, including skill contexts.
const failures = new Map<string, number>();
const keyFor = (identity: ArtifactRunIdentity) => JSON.stringify([identity.userId, identity.threadId, identity.runId]);

export function markArtifactCollectionFailure(identity: ArtifactRunIdentity): void {
  const now = Date.now();
  for (const [key, time] of failures) {
    if (now - time > 24 * 60 * 60 * 1000) failures.delete(key);
  }
  failures.set(keyFor(identity), now);
}

export async function persistArtifactCollectionFailure(identity: ArtifactRunIdentity, repository: ArtifactRepository): Promise<void> {
  const key = keyFor(identity);
  const observed = failures.get(key);
  if (observed === undefined) return;
  await repository.recordArtifactOperation(identity, `collection-failure:${observed}`, [], 'partial');
  if (failures.get(key) === observed) failures.delete(key);
}
