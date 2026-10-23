import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { withTrackedMutation, type ArtifactRunContext } from '../src/mastra/files/artifacts/collector';
import { settleArtifactRun } from '../src/mastra/files/artifacts/lifecycle';
import type { ArtifactRepository } from '../src/mastra/files/artifacts/repository';
import type { TurnArtifacts } from '../src/mastra/files/artifacts/types';

test('failed artifact persistence is reported as partial after the database recovers', async () => {
  const previous = { root: process.env.WORKSPACE_ROOT, database: process.env.DATABASE_URL };
  const root = await mkdtemp(join(tmpdir(), 'artifact-recovery-'));
  process.env.WORKSPACE_ROOT = root;
  delete process.env.DATABASE_URL;
  const identity = { userId: randomUUID(), threadId: randomUUID(), runId: randomUUID() };
  const context: ArtifactRunContext = { identity, auth: { userId: identity.userId, roles: ['user'] }, requestContext: new RequestContext() };
  let failed = true;
  let value: TurnArtifacts = { version: 1, ...identity, revision: 1, state: 'running',
    collectionStatus: 'complete', anchorMessageId: null, artifacts: [] };
  const repository = {
    ensureArtifactRun: async () => value,
    recordArtifactOperation: async (_: unknown, __: unknown, ___: unknown, status: 'complete' | 'partial') => {
      if (failed) throw new Error('temporary database outage');
      value = { ...value, collectionStatus: status, revision: value.revision + 1 };
      return value;
    },
    setArtifactRunState: async (_: unknown, state: TurnArtifacts['state']) => {
      value = { ...value, state, revision: value.revision + 1 };
      return value;
    },
  } as unknown as ArtifactRepository;
  try {
    const result = await withTrackedMutation(context, 'write-1', async () => {
      const dir = join(root, 'users', identity.userId, 'workspace', 'projects');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'deck.pptx'), 'actual-file');
      return 'success';
    }, { repository, paths: ['projects/deck.pptx'] });
    assert.equal(result, 'success', 'artifact failures must not re-execute or fail the file operation');
    failed = false;
    // Skill execution uses a different RequestContext for the same server-owned run.
    const settled = await settleArtifactRun({ ...context, requestContext: new RequestContext() }, { state: 'completed' }, { repository });
    assert.equal(settled.collectionStatus, 'partial');
  } finally {
    if (previous.root === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = previous.root;
    if (previous.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.database;
    await rm(root, { recursive: true, force: true });
  }
});

test('collection unavailable at startup does not fail or repeat the original file operation', async () => {
  const previous = { root: process.env.WORKSPACE_ROOT, database: process.env.DATABASE_URL };
  const root = await mkdtemp(join(tmpdir(), 'artifact-unavailable-'));
  process.env.WORKSPACE_ROOT = root;
  delete process.env.DATABASE_URL;
  const identity = { userId: randomUUID(), threadId: randomUUID(), runId: randomUUID() };
  const context: ArtifactRunContext = { identity, auth: { userId: identity.userId, roles: ['user'] }, requestContext: new RequestContext() };
  let executed = 0;
  try {
    const result = await withTrackedMutation(context, 'operation-unavailable', async () => {
      executed += 1;
      await writeFile(join(root, 'users', identity.userId, 'workspace', 'projects', 'result.txt'), 'kept');
      return 'kept';
    });
    assert.equal(result, 'kept');
    assert.equal(executed, 1);
  } finally {
    if (previous.root === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = previous.root;
    if (previous.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.database;
    await rm(root, { recursive: true, force: true });
  }
});
