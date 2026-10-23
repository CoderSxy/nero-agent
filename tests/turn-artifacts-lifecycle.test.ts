import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import { getPool } from '../src/mastra/auth/db';
import type { ArtifactRunContext } from '../src/mastra/files/artifacts/collector';
import {
  finishReasonToArtifactState,
  settleArtifactRun,
  startArtifactRun,
} from '../src/mastra/files/artifacts/lifecycle';
import { ArtifactRepository } from '../src/mastra/files/artifacts/repository';
import {
  bindSkillServerExecutionId,
  bindSkillThreadId,
} from '../src/mastra/skills/execution-context';

function safeDatabase(): boolean {
  try {
    const parsed = new URL(process.env.DATABASE_URL ?? '');
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

function contextFor(userId: string, threadId: string, runId: string): ArtifactRunContext {
  const requestContext = new RequestContext();
  requestContext.set('mastra__user', {
    id: userId,
    email: `${userId}@example.test`,
    displayName: 'L',
    roles: ['user'],
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  bindSkillThreadId(requestContext, threadId);
  bindSkillServerExecutionId(requestContext, runId);
  return {
    auth: { userId, roles: ['user'] },
    requestContext,
    identity: { userId, threadId, runId },
  };
}

test('finishReason mapping', () => {
  assert.equal(finishReasonToArtifactState('stop', false), 'completed');
  assert.equal(finishReasonToArtifactState('error', false), 'failed');
  assert.equal(finishReasonToArtifactState('aborted', false), 'cancelled');
  assert.equal(finishReasonToArtifactState('stop', true), 'cancelled');
  assert.equal(finishReasonToArtifactState('suspended', false), 'suspended');
});

test('start/settle/resume lifecycle is idempotent', {
  skip: safeDatabase() ? false : 'needs loopback DATABASE_URL',
}, async () => {
  const pool = getPool();
  const repo = new ArtifactRepository(pool);
  const userId = randomUUID();
  const threadId = `ta-life-${randomUUID()}`;
  const runId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO app_users (id, email, display_name, password_hash) VALUES ($1, $2, 'L', 'x')`,
      [userId, `l-${userId}@example.test`],
    );
    const ctx = contextFor(userId, threadId, runId);
    const first = await startArtifactRun(ctx, { repository: repo });
    const second = await startArtifactRun(ctx, { repository: repo });
    assert.equal(first.revision, second.revision);
    assert.equal(first.state, 'running');

    const suspended = await settleArtifactRun(ctx, { state: 'suspended' }, { repository: repo });
    assert.equal(suspended.state, 'suspended');
    const resumed = await startArtifactRun(ctx, { repository: repo });
    assert.equal(resumed.state, 'running');
    assert.ok(resumed.revision > suspended.revision);

    const done = await settleArtifactRun(ctx, {
      state: 'completed',
      anchorMessageId: 'msg-1',
    }, { repository: repo });
    assert.equal(done.state, 'completed');
    assert.equal(done.anchorMessageId, 'msg-1');

    const again = await settleArtifactRun(ctx, { state: 'completed' }, { repository: repo });
    assert.equal(again.state, 'completed');
    // Terminal cannot regress to running via start
    const stuck = await startArtifactRun(ctx, { repository: repo });
    assert.equal(stuck.state, 'completed');
  } finally {
    await client.query(`DELETE FROM app_agent_artifact_runs WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM app_users WHERE id = $1`, [userId]);
    client.release();
  }
});
