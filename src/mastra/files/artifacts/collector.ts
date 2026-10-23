import type { RequestContext } from '@mastra/core/request-context';
import { trustedAuth, type AuthContext } from '../../auth/auth-context';
import {
  readBoundServerExecutionId,
  readBoundSkillThreadId,
} from '../../skills/execution-context';
import { ensureUserWorkspace } from '../../workspace/manager';
import {
  workspaceMutationAdapter,
  withWorkspaceMutation,
  type WorkspaceMutationToken,
} from './mutation-coordinator';
import {
  createArtifactRepository,
  type ArtifactRepository,
} from './repository';
import {
  DEFAULT_SNAPSHOT_BUDGET,
  diffSnapshots,
  fingerprintWorkspaceFile,
  snapshotWorkspace,
  type SnapshotBudget,
} from './snapshot';
import type {
  ArtifactCollectionStatus,
  ArtifactMutation,
  ArtifactRunIdentity,
  FileFingerprint,
  TurnArtifacts,
  WorkspaceSnapshot,
} from './types';
import { markArtifactCollectionFailure } from './collection-failures';

export type ArtifactRunContext = {
  identity: ArtifactRunIdentity;
  auth: AuthContext;
  requestContext: RequestContext;
};

export type TrackedMutationOptions = {
  signal?: AbortSignal;
  /** Limit after-scan when the caller signal may already be aborted. */
  afterBudget?: SnapshotBudget;
  paths?: string[];
  repository?: ArtifactRepository;
};


export function resolveArtifactRunContext(requestContext: RequestContext): ArtifactRunContext {
  const auth = trustedAuth(requestContext);
  const runId = readBoundServerExecutionId(requestContext);
  const threadId = readBoundSkillThreadId(requestContext);
  if (!runId) throw new Error('Artifact collection requires a bound server runId');
  if (!threadId) throw new Error('Artifact collection requires a bound threadId');
  return {
    auth,
    requestContext,
    identity: { userId: auth.userId, threadId, runId },
  };
}

async function snapshotPaths(
  root: string,
  paths: string[],
  signal?: AbortSignal,
  budget?: SnapshotBudget,
): Promise<WorkspaceSnapshot> {
  if (paths.length === 0) {
    return snapshotWorkspace(root, { signal, budget, cacheUserKey: root });
  }
  const files = new Map<string, FileFingerprint>();
  const confirmedMissing = new Set<string>();
  let status: ArtifactCollectionStatus = 'complete';
  for (const path of paths) {
    if (signal?.aborted) {
      status = 'partial';
      break;
    }
    const result = await fingerprintWorkspaceFile(root, path, { cacheUserKey: root });
    if (result.partial) status = 'partial';
    if (result.missing) confirmedMissing.add(path);
    else if (result.fingerprint) files.set(path, result.fingerprint);
    else status = 'partial';
  }
  return { files, confirmedMissing, status };
}

/**
 * Lock user workspace, capture before/after fingerprints around work, persist mutations.
 * Collection failure never rethrows over a successful work result.
 */
export async function withTrackedMutation<T>(
  context: ArtifactRunContext,
  operationId: string,
  work: (token: WorkspaceMutationToken) => Promise<T>,
  options: TrackedMutationOptions = {},
): Promise<T> {
  let repository = options.repository;
  const root = await ensureUserWorkspace(context.auth);

  return withWorkspaceMutation(context.auth, async (token) => {
    let before: WorkspaceSnapshot = {
      files: new Map(),
      confirmedMissing: new Set(),
      status: 'partial',
    };
    try {
      repository ??= createArtifactRepository();
      await repository.ensureArtifactRun(context.identity);
      before = await snapshotPaths(root, options.paths ?? [], options.signal, DEFAULT_SNAPSHOT_BUDGET);
    } catch (error) {
      markArtifactCollectionFailure(context.identity);
      console.error('artifact before-snapshot failed', {
        runId: context.identity.runId,
        operationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    let result: T;
    let workError: unknown;
    try {
      result = await work(token);
    } catch (error) {
      workError = error;
      result = undefined as T;
    }

    try {
      const afterSignal = options.signal?.aborted ? undefined : options.signal;
      const after = await snapshotPaths(
        root,
        options.paths ?? [],
        afterSignal,
        options.afterBudget ?? { maxFiles: 5_000, maxBytes: 512 * 1024 * 1024, maxMs: 5_000 },
      );
      const changes = diffSnapshots(before, after);
      const status: ArtifactCollectionStatus =
        before.status === 'partial' || after.status === 'partial' ? 'partial' : 'complete';
      if (changes.length > 0 || status === 'partial') {
        repository ??= createArtifactRepository();
        await repository.recordArtifactOperation(context.identity, operationId, changes, status);
      }
    } catch (error) {
      markArtifactCollectionFailure(context.identity);
      console.error('artifact after-snapshot/persist failed', {
        runId: context.identity.runId,
        operationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (workError) throw workError;
    return result;
  }, {
    signal: options.signal,
    adapter: workspaceMutationAdapter(),
  });
}

/** Manual API writes: take the user lock only (no run attribution). */
export async function withManualWorkspaceMutation<T>(
  auth: AuthContext,
  work: (token: WorkspaceMutationToken) => Promise<T>,
  options: { signal?: AbortSignal; token?: WorkspaceMutationToken } = {},
): Promise<T> {
  return withWorkspaceMutation(auth, work, {
    signal: options.signal,
    token: options.token,
    adapter: workspaceMutationAdapter(),
  });
}

export type { ArtifactMutation, TurnArtifacts, WorkspaceMutationToken };
