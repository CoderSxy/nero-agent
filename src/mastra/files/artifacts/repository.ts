import { basename } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { AuthContext } from '../../auth/auth-context';
import { getPool } from '../../auth/db';
import { isArtifactPath } from './paths';
import type {
  ArtifactCollectionStatus,
  ArtifactMutation,
  ArtifactRunIdentity,
  ArtifactRunState,
  TurnArtifacts,
  WorkspaceArtifact,
} from './types';

type Db = Pool | PoolClient;

type RunRow = {
  run_id: string;
  user_id: string;
  thread_id: string;
  state: ArtifactRunState;
  revision: string | number;
  collection_status: ArtifactCollectionStatus;
  anchor_message_id: string | null;
  created_at: Date;
};

type ArtifactRow = {
  path: string;
  initial_etag: string | null;
  latest_etag: string | null;
  size: string | number;
};

const TERMINAL: ReadonlySet<ArtifactRunState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

function encodeCursor(createdAt: Date, runId: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt.toISOString(), r: runId }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; runId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      c?: unknown;
      r?: unknown;
    };
    if (typeof parsed.c !== 'string' || typeof parsed.r !== 'string' || !parsed.c || !parsed.r) {
      throw new Error('bad');
    }
    return { createdAt: parsed.c, runId: parsed.r };
  } catch {
    throw new ArtifactRepositoryError(400, 'Invalid cursor');
  }
}

export class ArtifactRepositoryError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ArtifactRepositoryError';
  }
}

function assertIdentity(identity: ArtifactRunIdentity): void {
  if (!identity.userId || !identity.threadId || !identity.runId) {
    throw new ArtifactRepositoryError(400, 'Artifact run identity is incomplete');
  }
}

function toArtifacts(rows: ArtifactRow[]): WorkspaceArtifact[] {
  const out: WorkspaceArtifact[] = [];
  for (const row of rows) {
    if (row.latest_etag == null) continue;
    if (row.initial_etag === row.latest_etag) continue;
    const change: WorkspaceArtifact['change'] = row.initial_etag == null ? 'created' : 'updated';
    out.push({
      path: row.path,
      source: 'personal',
      name: basename(row.path),
      change,
      size: Number(row.size),
      etag: row.latest_etag,
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function loadTurn(db: Db, identity: ArtifactRunIdentity): Promise<TurnArtifacts> {
  const run = await db.query<RunRow>(
    `SELECT run_id, user_id, thread_id, state, revision, collection_status, anchor_message_id, created_at
     FROM app_agent_artifact_runs
     WHERE run_id = $1 AND user_id = $2 AND thread_id = $3`,
    [identity.runId, identity.userId, identity.threadId],
  );
  const row = run.rows[0];
  if (!row) {
    throw new ArtifactRepositoryError(404, 'Artifact run not found');
  }
  const artifacts = await db.query<ArtifactRow>(
    `SELECT path, initial_etag, latest_etag, size
     FROM app_agent_run_artifacts WHERE run_id = $1 ORDER BY path`,
    [identity.runId],
  );
  return {
    version: 1,
    runId: row.run_id,
    threadId: row.thread_id,
    revision: Number(row.revision),
    state: row.state,
    collectionStatus: row.collection_status,
    anchorMessageId: row.anchor_message_id,
    artifacts: toArtifacts(artifacts.rows),
  };
}

export class ArtifactRepository {
  constructor(private readonly pool: Pool = getPool()) {}

  async ensureArtifactRun(identity: ArtifactRunIdentity): Promise<TurnArtifacts> {
    assertIdentity(identity);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<RunRow>(
        `SELECT run_id, user_id, thread_id, state, revision, collection_status, anchor_message_id, created_at
         FROM app_agent_artifact_runs WHERE run_id = $1 FOR UPDATE`,
        [identity.runId],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0]!;
        if (row.user_id !== identity.userId || row.thread_id !== identity.threadId) {
          throw new ArtifactRepositoryError(409, 'Artifact run identity conflict');
        }
        await client.query('COMMIT');
        return loadTurn(this.pool, identity);
      }
      await client.query(
        `INSERT INTO app_agent_artifact_runs
           (run_id, user_id, thread_id, state, revision, collection_status)
         VALUES ($1, $2, $3, 'running', 1, 'complete')`,
        [identity.runId, identity.userId, identity.threadId],
      );
      await client.query('COMMIT');
      return loadTurn(this.pool, identity);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordArtifactOperation(
    identity: ArtifactRunIdentity,
    operationId: string,
    changes: ArtifactMutation[],
    status: ArtifactCollectionStatus,
  ): Promise<TurnArtifacts> {
    assertIdentity(identity);
    if (!operationId.trim()) throw new ArtifactRepositoryError(400, 'operationId is required');
    for (const change of changes) {
      if (!isArtifactPath(change.path)) {
        throw new ArtifactRepositoryError(400, `Invalid artifact path: ${change.path}`);
      }
      if (change.after && change.after.size < 0) {
        throw new ArtifactRepositoryError(400, 'Invalid artifact size');
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query<RunRow>(
        `SELECT run_id, user_id, thread_id, state, revision, collection_status, anchor_message_id, created_at
         FROM app_agent_artifact_runs
         WHERE run_id = $1 FOR UPDATE`,
        [identity.runId],
      );
      const row = run.rows[0];
      if (!row) throw new ArtifactRepositoryError(404, 'Artifact run not found');
      if (row.user_id !== identity.userId || row.thread_id !== identity.threadId) {
        throw new ArtifactRepositoryError(409, 'Artifact run identity conflict');
      }

      const dup = await client.query(
        `SELECT 1 FROM app_agent_artifact_operations WHERE run_id = $1 AND operation_id = $2`,
        [identity.runId, operationId],
      );
      if (dup.rowCount && dup.rowCount > 0) {
        await client.query('COMMIT');
        return loadTurn(this.pool, identity);
      }

      await client.query(
        `INSERT INTO app_agent_artifact_operations (run_id, operation_id) VALUES ($1, $2)`,
        [identity.runId, operationId],
      );

      for (const change of changes) {
        const existing = await client.query<ArtifactRow>(
          `SELECT path, initial_etag, latest_etag, size
           FROM app_agent_run_artifacts WHERE run_id = $1 AND path = $2 FOR UPDATE`,
          [identity.runId, change.path],
        );
        if (!existing.rows[0]) {
          await client.query(
            `INSERT INTO app_agent_run_artifacts
               (run_id, path, initial_etag, latest_etag, size, last_operation_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              identity.runId,
              change.path,
              change.before?.etag ?? null,
              change.after?.etag ?? null,
              change.after?.size ?? 0,
              operationId,
            ],
          );
        } else {
          // initial_etag is immutable after first insert; only latest/size/op update.
          await client.query(
            `UPDATE app_agent_run_artifacts
             SET latest_etag = $3,
                 size = $4,
                 last_operation_id = $5,
                 updated_at = now()
             WHERE run_id = $1 AND path = $2`,
            [
              identity.runId,
              change.path,
              change.after?.etag ?? null,
              change.after?.size ?? 0,
              operationId,
            ],
          );
        }
      }

      const nextStatus = status === 'partial' || row.collection_status === 'partial'
        ? 'partial'
        : 'complete';
      await client.query(
        `UPDATE app_agent_artifact_runs
         SET revision = revision + 1,
             collection_status = $2,
             updated_at = now()
         WHERE run_id = $1`,
        [identity.runId, nextStatus],
      );
      await client.query('COMMIT');
      return loadTurn(this.pool, identity);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async setArtifactRunState(
    identity: ArtifactRunIdentity,
    state: ArtifactRunState,
    anchorMessageId?: string | null,
  ): Promise<TurnArtifacts> {
    assertIdentity(identity);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query<RunRow>(
        `SELECT run_id, user_id, thread_id, state, revision, collection_status, anchor_message_id, created_at
         FROM app_agent_artifact_runs WHERE run_id = $1 FOR UPDATE`,
        [identity.runId],
      );
      const row = run.rows[0];
      if (!row) throw new ArtifactRepositoryError(404, 'Artifact run not found');
      if (row.user_id !== identity.userId || row.thread_id !== identity.threadId) {
        throw new ArtifactRepositoryError(409, 'Artifact run identity conflict');
      }

      // Never regress a terminal state back to running/suspended via ordinary updates.
      if (TERMINAL.has(row.state) && (state === 'running' || state === 'suspended')) {
        await client.query('COMMIT');
        return loadTurn(this.pool, identity);
      }
      // Only resume may move suspended → running (caller passes running from resume path).
      if (row.state === state
        && (anchorMessageId === undefined || anchorMessageId === row.anchor_message_id)) {
        await client.query('COMMIT');
        return loadTurn(this.pool, identity);
      }

      const finished = TERMINAL.has(state) ? new Date() : null;
      await client.query(
        `UPDATE app_agent_artifact_runs
         SET state = $2,
             revision = revision + 1,
             anchor_message_id = COALESCE($3, anchor_message_id),
             finished_at = COALESCE($4, finished_at),
             updated_at = now()
         WHERE run_id = $1`,
        [
          identity.runId,
          state,
          anchorMessageId === undefined ? null : anchorMessageId,
          finished,
        ],
      );
      // When anchorMessageId is explicitly null, clear it.
      if (anchorMessageId === null) {
        await client.query(
          `UPDATE app_agent_artifact_runs SET anchor_message_id = NULL WHERE run_id = $1`,
          [identity.runId],
        );
      }
      await client.query('COMMIT');
      return loadTurn(this.pool, identity);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listArtifactRuns(
    auth: AuthContext,
    threadId: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ items: TurnArtifacts[]; nextCursor: string | null }> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new ArtifactRepositoryError(400, 'limit must be an integer from 1 to 100');
    }
    const params: unknown[] = [auth.userId, threadId, options.limit + 1];
    let cursorClause = '';
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      params.push(cursor.createdAt, cursor.runId);
      cursorClause = `AND (created_at, run_id) < ($4::timestamptz, $5)`;
    }
    const runs = await this.pool.query<RunRow>(
      `SELECT run_id, user_id, thread_id, state, revision, collection_status, anchor_message_id, created_at
       FROM app_agent_artifact_runs
       WHERE user_id = $1 AND thread_id = $2
       ${cursorClause}
       ORDER BY created_at DESC, run_id DESC
       LIMIT $3`,
      params,
    );
    const page = runs.rows.slice(0, options.limit);
    const items: TurnArtifacts[] = [];
    for (const row of page) {
      items.push(await loadTurn(this.pool, {
        userId: auth.userId,
        threadId: row.thread_id,
        runId: row.run_id,
      }));
    }
    const next = runs.rows.length > options.limit
      ? encodeCursor(page[page.length - 1]!.created_at, page[page.length - 1]!.run_id)
      : null;
    return { items, nextCursor: next };
  }

  async deleteThreadArtifactRuns(auth: AuthContext, threadId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM app_agent_artifact_runs WHERE user_id = $1 AND thread_id = $2`,
      [auth.userId, threadId],
    );
  }
}

export function createArtifactRepository(pool?: Pool): ArtifactRepository {
  return new ArtifactRepository(pool ?? getPool());
}

// Convenience wrappers matching the plan interface names.
const defaultRepo = () => createArtifactRepository();

export async function ensureArtifactRun(identity: ArtifactRunIdentity): Promise<TurnArtifacts> {
  return defaultRepo().ensureArtifactRun(identity);
}

export async function recordArtifactOperation(
  identity: ArtifactRunIdentity,
  operationId: string,
  changes: ArtifactMutation[],
  status: ArtifactCollectionStatus,
): Promise<TurnArtifacts> {
  return defaultRepo().recordArtifactOperation(identity, operationId, changes, status);
}

export async function setArtifactRunState(
  identity: ArtifactRunIdentity,
  state: ArtifactRunState,
  anchorMessageId?: string | null,
): Promise<TurnArtifacts> {
  return defaultRepo().setArtifactRunState(identity, state, anchorMessageId);
}

export async function listArtifactRuns(
  auth: AuthContext,
  threadId: string,
  options: { limit: number; cursor?: string },
): Promise<{ items: TurnArtifacts[]; nextCursor: string | null }> {
  return defaultRepo().listArtifactRuns(auth, threadId, options);
}

export async function deleteThreadArtifactRuns(auth: AuthContext, threadId: string): Promise<void> {
  return defaultRepo().deleteThreadArtifactRuns(auth, threadId);
}
