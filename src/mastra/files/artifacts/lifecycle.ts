import { persistArtifactCollectionFailure } from './collection-failures';
import {
  createArtifactRepository,
  type ArtifactRepository,
} from './repository';
import type {
  ArtifactRunContext,
} from './collector';
import type { ArtifactRunState, TurnArtifacts } from './types';

export async function startArtifactRun(
  context: ArtifactRunContext,
  deps: { repository?: ArtifactRepository } = {},
): Promise<TurnArtifacts> {
  const repository = deps.repository ?? createArtifactRepository();
  const current = await repository.ensureArtifactRun(context.identity);
  if (current.state === 'suspended') {
    return repository.setArtifactRunState(context.identity, 'running');
  }
  return current;
}

export async function settleArtifactRun(
  context: ArtifactRunContext,
  input: {
    state: Exclude<ArtifactRunState, 'running'>;
    anchorMessageId?: string | null;
  },
  deps: { repository?: ArtifactRepository } = {},
): Promise<TurnArtifacts> {
  const repository = deps.repository ?? createArtifactRepository();
  await repository.ensureArtifactRun(context.identity);
  await persistArtifactCollectionFailure(context.identity, repository);
  return repository.setArtifactRunState(context.identity, input.state, input.anchorMessageId);
}

export function finishReasonToArtifactState(
  finishReason: string | undefined,
  aborted: boolean | undefined,
): Exclude<ArtifactRunState, 'running'> {
  if (aborted || finishReason === 'aborted') return 'cancelled';
  if (finishReason === 'suspended') return 'suspended';
  if (finishReason === 'error' || finishReason === 'other') return 'failed';
  return 'completed';
}
