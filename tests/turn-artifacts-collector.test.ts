import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import { getPool } from '../src/mastra/auth/db';
import {
  withTrackedMutation,
  type ArtifactRunContext,
} from '../src/mastra/files/artifacts/collector';
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

function etag(content: string | Buffer): string {
  return `"${createHash('sha256').update(content).digest('hex')}"`;
}

test('withTrackedMutation persists real file creates and updates for a run', {
  skip: safeDatabase() ? false : 'needs loopback DATABASE_URL',
}, async () => {
  const pool = getPool();
  const repo = new ArtifactRepository(pool);
  const userId = randomUUID();
  const threadId = `ta-collect-${randomUUID()}`;
  const runId = randomUUID();
  const client = await pool.connect();
  const previousRoot = process.env.WORKSPACE_ROOT;
  const root = await mkdtemp(join(tmpdir(), 'ta-collect-ws-'));
  process.env.WORKSPACE_ROOT = root;

  try {
    await client.query(
      `INSERT INTO app_users (id, email, display_name, password_hash) VALUES ($1, $2, 'C', 'x')`,
      [userId, `c-${userId}@example.test`],
    );
    const userRoot = join(root, 'users', userId, 'workspace');
    await mkdir(join(userRoot, 'threads', threadId, 'output'), { recursive: true });
    await mkdir(join(userRoot, 'projects'), { recursive: true });

    const requestContext = new RequestContext();
    requestContext.set('mastra__user', {
      id: userId,
      email: `c-${userId}@example.test`,
      displayName: 'C',
      roles: ['user'],
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    bindSkillThreadId(requestContext, threadId);
    bindSkillServerExecutionId(requestContext, runId);

    const context: ArtifactRunContext = {
      auth: { userId, roles: ['user'] },
      requestContext,
      identity: { userId, threadId, runId },
    };

    const pptx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    const pathA = `threads/${threadId}/output/deck.pptx`;
    await withTrackedMutation(context, 'op-write-pptx', async () => {
      await writeFile(join(userRoot, ...pathA.split('/')), pptx);
    }, { paths: [pathA], repository: repo });

    let snap = await repo.ensureArtifactRun(context.identity);
    assert.equal(snap.artifacts.length, 1);
    assert.equal(snap.artifacts[0]!.path, pathA);
    assert.equal(snap.artifacts[0]!.change, 'created');
    assert.equal(snap.artifacts[0]!.etag, etag(pptx));

    const pathB = 'projects/note.md';
    await writeFile(join(userRoot, 'projects', 'note.md'), 'v1');
    await withTrackedMutation(context, 'op-update-note', async () => {
      await writeFile(join(userRoot, 'projects', 'note.md'), 'v2');
    }, { paths: [pathB], repository: repo });

    snap = await repo.ensureArtifactRun(context.identity);
    const note = snap.artifacts.find((a) => a.path === pathB);
    assert.ok(note);
    assert.equal(note!.change, 'updated');
    assert.equal(note!.etag, etag('v2'));

    // Same-name different directories do not merge
    assert.equal(snap.artifacts.filter((a) => a.name === 'deck.pptx' || a.path.endsWith('deck.pptx')).length, 1);
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
    await client.query(`DELETE FROM app_agent_artifact_runs WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM app_users WHERE id = $1`, [userId]);
    client.release();
  }
});
