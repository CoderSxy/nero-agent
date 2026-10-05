import type { AuthContext } from './auth-context';

export type ThreadRecord = { id: string; resourceId?: string | null };

export type ThreadLookup = {
  getThreadById(args: { threadId: string }): Promise<ThreadRecord | null>;
};

export type OwnedThread = { id: string; resourceId: string };

export class ThreadGuardError extends Error {
  readonly status: 401 | 403 | 404;

  constructor(status: 401 | 403 | 404, message: string) {
    super(message);
    this.name = 'ThreadGuardError';
    this.status = status;
  }
}

export async function assertThreadOwned(
  auth: AuthContext,
  threadId: string,
  lookup: ThreadLookup,
): Promise<OwnedThread> {
  if (!threadId) throw new ThreadGuardError(404, 'Thread not found');
  const thread = await lookup.getThreadById({ threadId });
  if (!thread) throw new ThreadGuardError(404, 'Thread not found');
  if (!thread.resourceId || thread.resourceId !== auth.userId) {
    throw new ThreadGuardError(403, 'Access denied: thread belongs to a different resource');
  }
  return { id: thread.id, resourceId: thread.resourceId };
}
