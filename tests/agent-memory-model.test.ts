import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import { getPool } from '../src/mastra/auth/db';
import { createUser, type AuthUser } from '../src/mastra/auth/service';
import { memoryForRequest } from '../src/mastra/agents/memory-model';
import {
  chatModelRefContextKey,
  memoryModelRefContextKey,
  trustedUserContextKey,
} from '../src/mastra/models/resolver';
import { createModel, updateModel } from '../src/mastra/models/service';
import type { ModelInput } from '../src/mastra/models/types';

const FIXTURE_ORIGIN = 'https://models.example.test';
const FIXTURE_KEY = 'sk-test-1234';
const ROTATED_KEY = 'sk-test-5678';

function configureEnv() {
  process.env.MODEL_CONFIG_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
  const allowlist = (process.env.MODEL_ENDPOINT_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!allowlist.includes(FIXTURE_ORIGIN)) allowlist.push(FIXTURE_ORIGIN);
  process.env.MODEL_ENDPOINT_ALLOWLIST = allowlist.join(',');
}

function contextOf(entries: Record<string, unknown>) {
  const requestContext = new RequestContext();
  for (const [key, value] of Object.entries(entries)) requestContext.set(key, value);
  return requestContext;
}

function memoryModels(memory: Awaited<ReturnType<typeof memoryForRequest>>) {
  const config = memory.getMergedThreadConfig();
  const observational = typeof config.observationalMemory === 'object' ? config.observationalMemory : undefined;
  return {
    observation: observational?.observation?.model,
    reflection: observational?.reflection?.model,
    title: typeof config.generateTitle === 'object' ? config.generateTitle.model : undefined,
    enabled: observational !== undefined && config.observationalMemory !== false,
  };
}

/** A memory that could not resolve an authorized model must not reach any provider. */
function assertNoModels(memory: Awaited<ReturnType<typeof memoryForRequest>>) {
  const models = memoryModels(memory);
  assert.equal(models.observation, undefined);
  assert.equal(models.reflection, undefined);
  assert.equal(models.title, undefined);
  assert.equal(memory.getMergedThreadConfig().generateTitle, false);
}

test('agent memory resolves observation, reflection and title models from the authorized catalog',
  { skip: !process.env.DATABASE_URL }, async () => {
  configureEnv();
  const suffix = randomUUID();
  const password = 'correct horse battery staple';
  const userIds: string[] = [];
  const pool = getPool();
  const input = (name: string, overrides: Partial<ModelInput> = {}): ModelInput => ({
    displayName: name,
    providerId: `prov-${suffix}`,
    modelId: `model-${name}`,
    baseUrl: `${FIXTURE_ORIGIN}/v1`,
    apiKey: FIXTURE_KEY,
    ...overrides,
  });
  const configOf = (name: string, apiKey = FIXTURE_KEY) => ({
    id: `prov-${suffix}/model-${name}`,
    url: `${FIXTURE_ORIGIN}/v1`,
    apiKey,
    api: 'chat',
  });
  let admin: AuthUser | undefined;

  try {
    const userA = await createUser({ email: `a-${suffix}@example.test`, displayName: 'A', password, role: 'user' });
    const userB = await createUser({ email: `b-${suffix}@example.test`, displayName: 'B', password, role: 'user' });
    userIds.push(userA.id, userB.id);

    const memoryModel = await createModel('private', userA, input('mem-a'));
    const chatModel = await createModel('private', userA, input('chat-a'));
    const foreign = await createModel('private', userB, input('mem-b'));
    const memoryId = memoryModel.ref.slice('private:'.length);

    const selected = contextOf({
      [trustedUserContextKey]: userA,
      [chatModelRefContextKey]: chatModel.ref,
      [memoryModelRefContextKey]: memoryModel.ref,
    });
    const memory = await memoryForRequest({ requestContext: selected });
    const models = memoryModels(memory);
    assert.deepEqual(models.observation, configOf('mem-a'));
    assert.deepEqual(models.reflection, configOf('mem-a'));
    assert.deepEqual(models.title, configOf('mem-a'));

    // The same record version reuses the cached Memory instance.
    assert.equal(await memoryForRequest({ requestContext: selected }), memory);

    // Replacing the stored Key takes effect on the next request.
    await updateModel('private', memoryId, userA, { apiKey: ROTATED_KEY });
    const rotated = await memoryForRequest({ requestContext: selected });
    assert.notEqual(rotated, memory);
    assert.deepEqual(memoryModels(rotated).observation, configOf('mem-a', ROTATED_KEY));
    assert.deepEqual(memoryModels(rotated).title, configOf('mem-a', ROTATED_KEY));

    // Without a memory ref the chat selection is reused.
    const chatOnly = await memoryForRequest({
      requestContext: contextOf({ [trustedUserContextKey]: userA, [chatModelRefContextKey]: chatModel.ref }),
    });
    assert.deepEqual(memoryModels(chatOnly).observation, configOf('chat-a'));

    // A forged identity cannot pull another user's model into memory.
    assertNoModels(await memoryForRequest({
      requestContext: contextOf({
        user: userB,
        [trustedUserContextKey]: userA,
        [memoryModelRefContextKey]: foreign.ref,
      }),
    }));

    // No trusted identity means no model and no provider credentials at all.
    assertNoModels(await memoryForRequest({ requestContext: contextOf({ user: userA }) }));

    // A selected record that becomes unusable is never swapped for another model.
    await updateModel('private', memoryId, userA, { enabled: false });
    assertNoModels(await memoryForRequest({ requestContext: selected }));
  } finally {
    if (userIds.length) await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [userIds]);
    await pool.end();
  }
});
