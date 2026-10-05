import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import { getPool } from '../src/mastra/auth/db';
import { createUser, getUserByToken, login, type AuthUser } from '../src/mastra/auth/service';
import { agent } from '../src/mastra/agents/agent';
import {
  chatModelRefContextKey,
  memoryModelRefContextKey,
  resolveModel,
  resolveSelectedModel,
} from '../src/mastra/models/resolver';
import { createModel, updateModel } from '../src/mastra/models/service';
import { ModelCatalogError, type ModelInput, type ModelRef } from '../src/mastra/models/types';

const FIXTURE_ORIGIN = 'https://models.example.test';
const FIXTURE_KEY = 'sk-test-1234';
const MASTRA_USER_KEY = 'mastra__user';
const FORGED_TRUSTED_USER_KEY = 'nero-agent.trusted-user';

// Mirrors the reserved set in @mastra/server: a client may populate any other
// RequestContext key through the request body or the requestContext query param.
const RESERVED_CONTEXT_KEYS = new Set([
  'mastra__resourceId', 'mastra__threadId', 'mastra__user', 'mastra__userPermissions',
  'mastra__userRoles', 'mastra__authToken', 'mastra__isStudio', 'mastra__authMode',
  'mastra__inheritedMemory', 'organizationId',
]);

function configureEnv() {
  process.env.MODEL_CONFIG_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
  const allowlist = (process.env.MODEL_ENDPOINT_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!allowlist.includes(FIXTURE_ORIGIN)) allowlist.push(FIXTURE_ORIGIN);
  process.env.MODEL_ENDPOINT_ALLOWLIST = allowlist.join(',');
}

async function assertCode(promise: Promise<unknown>, code: ModelCatalogError['code']) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ModelCatalogError, `expected ModelCatalogError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

/** Replays the deployer pipeline: client context first, then server-verified identity. */
async function requestContextFor(clientContext: Record<string, unknown>, token: string) {
  const requestContext = new RequestContext();
  for (const [key, value] of Object.entries(clientContext)) {
    if (RESERVED_CONTEXT_KEYS.has(key)) continue;
    requestContext.set(key, value);
  }
  const user = await getUserByToken(token);
  assert.ok(user, 'fixture token should authenticate');
  requestContext.set(MASTRA_USER_KEY, user);
  requestContext.set('user', user);
  return requestContext;
}

function contextOf(entries: Record<string, unknown>) {
  const requestContext = new RequestContext();
  for (const [key, value] of Object.entries(entries)) requestContext.set(key, value);
  return requestContext;
}

test('model resolver binds chat and memory models to the authenticated catalog',
  { skip: !process.env.DATABASE_URL }, async () => {
  configureEnv();
  const suffix = randomUUID();
  const password = 'correct horse battery staple';
  const userIds: string[] = [];
  const publicIds: string[] = [];
  const pool = getPool();
  const input = (name: string, overrides: Partial<ModelInput> = {}): ModelInput => ({
    displayName: name,
    providerId: `prov-${suffix}`,
    modelId: `model-${name}`,
    baseUrl: `${FIXTURE_ORIGIN}/v1`,
    apiKey: FIXTURE_KEY,
    ...overrides,
  });
  const configOf = (name: string, overrides: Record<string, unknown> = {}) => ({
    id: `prov-${suffix}/model-${name}`,
    url: `${FIXTURE_ORIGIN}/v1`,
    apiKey: FIXTURE_KEY,
    api: 'chat',
    ...overrides,
  });

  const previousDefaults = (await pool.query<{ id: string }>(
    'SELECT id FROM app_public_models WHERE is_default')).rows.map((row) => row.id);
  let admin: AuthUser | undefined;

  try {
    admin = await createUser({ email: `admin-${suffix}@example.test`, displayName: 'Admin', password, role: 'admin' });
    const userA = await createUser({ email: `a-${suffix}@example.test`, displayName: 'A', password, role: 'user' });
    const userB = await createUser({ email: `b-${suffix}@example.test`, displayName: 'B', password, role: 'user' });
    userIds.push(admin.id, userA.id, userB.id);
    const tokenA = (await login(`a-${suffix}@example.test`, password))!.token;

    const publicDefault = await createModel('public', admin, input('pub-default', { isDefault: true }));
    const publicResponses = await createModel('public', admin, input('pub-responses', { apiMode: 'responses' }));
    publicIds.push(publicDefault.ref.slice('public:'.length), publicResponses.ref.slice('public:'.length));
    const privateA = await createModel('private', userA, input('priv-a'));
    const privateB = await createModel('private', userB, input('priv-b'));
    const disabledA = await createModel('private', userA, input('priv-a-off', { enabled: false }));

    // Stored configuration reaches the provider verbatim, with the key decrypted.
    assert.deepEqual(await resolveModel(publicDefault.ref, userA), configOf('pub-default'));
    assert.deepEqual(await resolveModel(publicResponses.ref, userA), configOf('pub-responses', { api: 'responses' }));
    assert.deepEqual(await resolveModel(privateA.ref, userA), configOf('priv-a'));
    assert.deepEqual(await resolveModel(privateB.ref, userB), configOf('priv-b'));

    await assertCode(resolveModel(privateB.ref, userA), 'not_found');
    await assertCode(resolveModel(privateA.ref, userB), 'not_found');
    await assertCode(resolveModel(disabledA.ref, userA), 'disabled');
    await assertCode(resolveModel('private:not-a-uuid' as ModelRef, userA), 'invalid_input');
    await assertCode(resolveModel(`public:${randomUUID()}` as ModelRef, userA), 'not_found');

    // The endpoint allowlist is enforced again when the connection is built.
    const allowlist = process.env.MODEL_ENDPOINT_ALLOWLIST;
    process.env.MODEL_ENDPOINT_ALLOWLIST = 'https://unrelated.example.test';
    await assertCode(resolveModel(publicDefault.ref, userA), 'invalid_input');
    process.env.MODEL_ENDPOINT_ALLOWLIST = allowlist;

    // Selection reads the ref from the request context and the identity from server auth.
    const ownChat = await requestContextFor({ [chatModelRefContextKey]: privateA.ref }, tokenA);
    assert.deepEqual((await resolveSelectedModel(ownChat, 'chat')).config, configOf('priv-a'));
    assert.equal((await resolveSelectedModel(ownChat, 'chat')).ref, privateA.ref);

    const ownMemory = await requestContextFor({
      [chatModelRefContextKey]: privateA.ref,
      [memoryModelRefContextKey]: publicDefault.ref,
    }, tokenA);
    assert.deepEqual((await resolveSelectedModel(ownMemory, 'memory')).config, configOf('pub-default'));

    // A client that forges `user` cannot reach another user's private model.
    const forged = await requestContextFor({
      user: userB,
      [chatModelRefContextKey]: privateB.ref,
    }, tokenA);
    await assertCode(resolveSelectedModel(forged, 'chat'), 'not_found');

    // Even if the forged value survives the merge, the reserved identity decides.
    const divergent = contextOf({
      user: userB,
      [MASTRA_USER_KEY]: userA,
      [chatModelRefContextKey]: privateB.ref,
    });
    await assertCode(resolveSelectedModel(divergent, 'chat'), 'not_found');
    assert.deepEqual(
      (await resolveSelectedModel(contextOf({
        user: userB,
        [MASTRA_USER_KEY]: userA,
        [chatModelRefContextKey]: privateA.ref,
      }), 'chat')).config,
      configOf('priv-a'),
    );

    // A client-supplied custom identity key is ignored: resolution stays bound to mastra__user.
    await assertCode(
      resolveSelectedModel(contextOf({
        [MASTRA_USER_KEY]: userA,
        [FORGED_TRUSTED_USER_KEY]: userB,
        [chatModelRefContextKey]: privateB.ref,
      }), 'chat'),
      'not_found',
    );
    assert.deepEqual(
      (await resolveSelectedModel(contextOf({
        [MASTRA_USER_KEY]: userA,
        [FORGED_TRUSTED_USER_KEY]: userB,
        [chatModelRefContextKey]: privateA.ref,
      }), 'chat')).config,
      configOf('priv-a'),
    );
    // Custom identity keys never authenticate on their own.
    await assertCode(
      resolveSelectedModel(contextOf({ [FORGED_TRUSTED_USER_KEY]: userB, [chatModelRefContextKey]: privateB.ref }), 'chat'),
      'forbidden',
    );

    // Unauthenticated and malformed selections fail closed.
    await assertCode(resolveSelectedModel(contextOf({ user: userA }), 'chat'), 'forbidden');
    await assertCode(
      resolveSelectedModel(contextOf({ [MASTRA_USER_KEY]: userA, [chatModelRefContextKey]: 'deepseek/deepseek-v4-flash' }), 'chat'),
      'invalid_input',
    );

    // Without a ref the request falls back to the enabled public default only.
    const noRef = await requestContextFor({}, tokenA);
    assert.deepEqual((await resolveSelectedModel(noRef, 'chat')).config, configOf('pub-default'));
    assert.deepEqual((await resolveSelectedModel(noRef, 'memory')).config, configOf('pub-default'));
    // The memory model falls back to the chat selection before the public default.
    assert.deepEqual(
      (await resolveSelectedModel(await requestContextFor({ [chatModelRefContextKey]: privateA.ref }, tokenA), 'memory')).config,
      configOf('priv-a'),
    );

    // Disable only this test's default; other users' public models stay untouched.
    await updateModel('public', publicIds[0], admin, { enabled: false });
    try {
      await assert.rejects(resolveSelectedModel(noRef, 'chat'), (error: unknown) => {
        assert.ok(error instanceof ModelCatalogError);
        assert.equal(error.code, 'no_public_models');
        assert.match(error.message, /请先配置公共模型/);
        return true;
      });
      // An authenticated independent-page request may still use a private model.
      assert.deepEqual(
        (await resolveSelectedModel(await requestContextFor({ [chatModelRefContextKey]: privateA.ref }, tokenA), 'chat')).config,
        configOf('priv-a'),
      );
    } finally {
      await updateModel('public', publicIds[0], admin, { enabled: true, isDefault: true });
    }

    // The registered agent resolves its model through the same path.
    const agentModel = await agent.getModel({
      requestContext: await requestContextFor({ [chatModelRefContextKey]: privateA.ref }, tokenA),
    });
    assert.equal(agentModel.specificationVersion, 'v3');
    assert.equal(agentModel.provider, `prov-${suffix}.chat`);
    assert.equal(agentModel.modelId, 'model-priv-a');

    await assert.rejects(agent.getModel({
      requestContext: await requestContextFor({ user: userB, [chatModelRefContextKey]: privateB.ref }, tokenA),
    }), (error: unknown) => {
      assert.ok(error instanceof ModelCatalogError, `expected ModelCatalogError, got ${String(error)}`);
      assert.equal(error.code, 'not_found');
      return true;
    });
  } finally {
    if (publicIds.length) await pool.query('DELETE FROM app_public_models WHERE id = ANY($1::uuid[])', [publicIds]);
    if (userIds.length) await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [userIds]);
    if (previousDefaults.length) {
      await pool.query('UPDATE app_public_models SET is_default = true WHERE id = ANY($1::uuid[])', [previousDefaults]);
    }
    await pool.end();
  }
});
