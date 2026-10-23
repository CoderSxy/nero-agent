import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { getPool } from '../src/mastra/auth/db';
import {
  ArtifactRepository,
  ArtifactRepositoryError,
} from '../src/mastra/files/artifacts/repository';
import type { ArtifactMutation, FileFingerprint } from '../src/mastra/files/artifacts/types';

function safeDatabase(): boolean {
  try {
    const parsed = new URL(process.env.DATABASE_URL ?? '');
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

function fp(content: string, size = content.length): FileFingerprint {
  return {
    etag: `"${createHash('sha256').update(content).digest('hex')}"`,
    size,
    dev: '1',
    ino: String(Math.random()),
    mtimeNs: '1',
    ctimeNs: '1',
  };
}

function mut(path: string, before: FileFingerprint | null, after: FileFingerprint | null): ArtifactMutation {
  return { path, before, after };
}

const skip = safeDatabase() ? false : 'needs loopback DATABASE_URL';

test('artifact repository merge, auth, pagination, and cleanup', { skip }, async () => {
  const pool = getPool();
  const repo = new ArtifactRepository(pool);
  const userA = randomUUID();
  const userB = randomUUID();
  const thread = `ta-repo-${randomUUID()}`;
  const threadOther = `ta-repo-other-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO app_users (id, email, display_name, password_hash)
       VALUES ($1, $2, 'A', 'x'), ($3, $4, 'B', 'x')`,
      [userA, `a-${userA}@example.test`, userB, `b-${userB}@example.test`],
    );
  } finally {
    client.release();
  }

  try {
    const identity = { userId: userA, threadId: thread, runId };
    const first = await repo.ensureArtifactRun(identity);
    assert.equal(first.state, 'running');
    assert.equal(first.revision, 1);
    assert.equal(first.artifacts.length, 0);

    // Same run cannot change owner/thread
    await assert.rejects(
      () => repo.ensureArtifactRun({ userId: userB, threadId: thread, runId }),
      (error: unknown) => error instanceof ArtifactRepositoryError && error.status === 409,
    );
    await assert.rejects(
      () => repo.ensureArtifactRun({ userId: userA, threadId: threadOther, runId }),
      (error: unknown) => error instanceof ArtifactRepositoryError && error.status === 409,
    );

    // Cross-user list empty
    const foreign = await repo.listArtifactRuns({ userId: userB, roles: ['user'] }, thread, { limit: 50 });
    assert.equal(foreign.items.length, 0);

    const created = fp('hello');
    const afterWrite = await repo.recordArtifactOperation(
      identity,
      'op-1',
      [mut('projects/a.md', null, created)],
      'complete',
    );
    assert.equal(afterWrite.revision, 2);
    assert.equal(afterWrite.artifacts.length, 1);
    assert.equal(afterWrite.artifacts[0]!.change, 'created');

    // Duplicate operationId is no-op
    const dup = await repo.recordArtifactOperation(
      identity,
      'op-1',
      [mut('projects/a.md', null, fp('other'))],
      'complete',
    );
    assert.equal(dup.revision, 2);
    assert.equal(dup.artifacts[0]!.etag, created.etag);

    // created then updated stays created
    const updated = fp('hello!');
    const afterUpdate = await repo.recordArtifactOperation(
      identity,
      'op-2',
      [mut('projects/a.md', created, updated)],
      'complete',
    );
    assert.equal(afterUpdate.artifacts[0]!.change, 'created');
    assert.equal(afterUpdate.artifacts[0]!.etag, updated.etag);

    // Keep created file after further edits (still created)
    await repo.recordArtifactOperation(
      identity,
      'op-3',
      [mut('projects/a.md', updated, created)],
      'complete',
    );

    // Pre-existing file updated then restored to initial etag → drop from list
    const pre = fp('base');
    await repo.recordArtifactOperation(identity, 'op-4', [mut('projects/b.md', pre, fp('edit'))], 'complete');
    const undone = await repo.recordArtifactOperation(
      identity,
      'op-5',
      [mut('projects/b.md', fp('edit'), pre)],
      'complete',
    );
    assert.equal(undone.artifacts.some((a) => a.path === 'projects/b.md'), false);

    // created then deleted → not shown
    await repo.recordArtifactOperation(identity, 'op-6', [mut('projects/c.md', null, fp('c'))], 'complete');
    const deleted = await repo.recordArtifactOperation(
      identity,
      'op-7',
      [mut('projects/c.md', fp('c'), null)],
      'complete',
    );
    assert.equal(deleted.artifacts.some((a) => a.path === 'projects/c.md'), false);

    // Failed run keeps valid files
    const failed = await repo.setArtifactRunState(identity, 'failed');
    assert.equal(failed.state, 'failed');
    assert.ok(failed.artifacts.some((a) => a.path === 'projects/a.md'));

    // Cannot regress terminal → running
    const stuck = await repo.setArtifactRunState(identity, 'running');
    assert.equal(stuck.state, 'failed');

    // Transaction rollback on invalid path
    const beforeBad = stuck.revision;
    await assert.rejects(
      () => repo.recordArtifactOperation(
        identity,
        'op-bad',
        [mut('../evil', null, fp('x'))],
        'complete',
      ),
    );
    const afterBad = await repo.ensureArtifactRun(identity);
    assert.equal(afterBad.revision, beforeBad);

    // Pagination: 51 runs
    const pageThread = `ta-page-${randomUUID()}`;
    for (let i = 0; i < 51; i += 1) {
      const id = { userId: userA, threadId: pageThread, runId: `page-run-${String(i).padStart(3, '0')}` };
      await repo.ensureArtifactRun(id);
      await repo.setArtifactRunState(id, 'completed');
    }
    const page1 = await repo.listArtifactRuns({ userId: userA, roles: ['user'] }, pageThread, { limit: 50 });
    assert.equal(page1.items.length, 50);
    assert.ok(page1.nextCursor);
    const page2 = await repo.listArtifactRuns(
      { userId: userA, roles: ['user'] },
      pageThread,
      { limit: 50, cursor: page1.nextCursor! },
    );
    assert.equal(page2.items.length, 1);
    assert.equal(page2.nextCursor, null);
    const allIds = [...page1.items, ...page2.items].map((item) => item.runId);
    assert.equal(new Set(allIds).size, 51);

    // Delete only target thread
    await repo.deleteThreadArtifactRuns({ userId: userA, roles: ['user'] }, pageThread);
    const gone = await repo.listArtifactRuns({ userId: userA, roles: ['user'] }, pageThread, { limit: 50 });
    assert.equal(gone.items.length, 0);
    const kept = await repo.listArtifactRuns({ userId: userA, roles: ['user'] }, thread, { limit: 50 });
    assert.ok(kept.items.some((item) => item.runId === runId));

    // Fresh repository instance still reads
    const again = new ArtifactRepository(pool);
    const reloaded = await again.ensureArtifactRun(identity);
    assert.equal(reloaded.state, 'failed');
    assert.ok(reloaded.artifacts.length >= 1);
  } finally {
    const cleanup = await pool.connect();
    try {
      await cleanup.query(`DELETE FROM app_agent_artifact_runs WHERE user_id IN ($1, $2)`, [userA, userB]);
      await cleanup.query(`DELETE FROM app_users WHERE id IN ($1, $2)`, [userA, userB]);
    } finally {
      cleanup.release();
    }
  }
});
