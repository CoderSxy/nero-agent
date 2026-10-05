import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import { memoryForRequest } from '../src/mastra/agents/memory-model';
import { getPool } from '../src/mastra/auth/db';
import { createUser } from '../src/mastra/auth/service';
import { chatModelRefContextKey } from '../src/mastra/models/resolver';
import { createModel } from '../src/mastra/models/service';
import type { ModelInput } from '../src/mastra/models/types';

const FIXTURE_ORIGIN = 'https://models.example.test';
const MASTRA_USER_KEY = 'mastra__user';

function configureEnv() {
  process.env.MODEL_CONFIG_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
  const allowlist = (process.env.MODEL_ENDPOINT_ALLOWLIST ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  if (!allowlist.includes(FIXTURE_ORIGIN)) allowlist.push(FIXTURE_ORIGIN);
  process.env.MODEL_ENDPOINT_ALLOWLIST = allowlist.join(',');
}

test('agent Memory pins observational and retrieval scope to the current thread',
  { skip: !process.env.DATABASE_URL }, async () => {
  configureEnv();
  const suffix = randomUUID();
  const pool = getPool();
  const userIds: string[] = [];
  try {
    const userA = await createUser({
      email: `mem-a-${suffix}@example.test`, displayName: 'A', password: 'correct horse battery staple', role: 'user',
    });
    userIds.push(userA.id);
    const model = await createModel('private', userA, {
      displayName: 'mem',
      providerId: `prov-${suffix}`,
      modelId: 'model-mem',
      baseUrl: `${FIXTURE_ORIGIN}/v1`,
      apiKey: 'sk-test-1234',
    } satisfies ModelInput);
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_USER_KEY, userA);
    requestContext.set(chatModelRefContextKey, model.ref);
    const memory = await memoryForRequest({ requestContext });
    const config = memory.getMergedThreadConfig();
    const observational = typeof config.observationalMemory === 'object' ? config.observationalMemory : undefined;
    assert.equal(observational?.scope, 'thread');
    assert.equal(
      observational && typeof observational.retrieval === 'object' ? observational.retrieval.scope : undefined,
      'thread',
    );
    assert.equal(config.semanticRecall, false);
    const workingMemory = config.workingMemory;
    assert.ok(workingMemory === undefined || workingMemory === false
      || (typeof workingMemory === 'object' && workingMemory.enabled === false));
  } finally {
    if (userIds.length) await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [userIds]);
    await pool.end();
  }
});
