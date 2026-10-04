import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import { getPool } from '../src/mastra/auth/db';
import { createUser, getUserByToken, login } from '../src/mastra/auth/service';
import { modelRoutes } from '../src/mastra/models/routes';
import { findAuthorizedModel } from '../src/mastra/models/service';
import { decryptApiKey } from '../src/mastra/models/crypto';

const FIXTURE_ORIGIN = 'https://models.example.test';
const FIXTURE_KEY = 'sk-test-1234';
const NEW_KEY = 'sk-test-5678';

function configureEnv() {
  process.env.MODEL_CONFIG_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
  const allowlist = (process.env.MODEL_ENDPOINT_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!allowlist.includes(FIXTURE_ORIGIN)) allowlist.push(FIXTURE_ORIGIN);
  process.env.MODEL_ENDPOINT_ALLOWLIST = allowlist.join(',');
}

// In-process server that mounts the real registered handlers and reproduces Mastra's
// auth contract: routes default to requiresAuth, the bearer token is verified with the
// configured authenticateToken, and the user is exposed via requestContext.
function buildApp(routes: ApiRoute[]) {
  const app = new Hono();
  for (const route of routes) {
    if (!('handler' in route) || !route.handler) throw new Error(`route ${route.path} has no handler`);
    const handler = route.handler;
    app.on(route.method, route.path, async (c, next) => {
      const requestContext = new RequestContext();
      c.set('requestContext', requestContext);
      if (route.requiresAuth !== false) {
        const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? '';
        const user = await getUserByToken(token);
        if (!user) return c.json({ error: 'Unauthorized' }, 401);
        requestContext.set('user', user);
      }
      return handler(c, next);
    });
  }
  return app;
}

test('modelRoutes registers every method and path from the API contract', () => {
  const registered = modelRoutes.map((route) => `${route.method} ${route.path}`).sort();
  assert.deepEqual(registered, [
    'DELETE /model-catalog/private/:id',
    'DELETE /model-catalog/public/:id',
    'GET /model-catalog',
    'GET /model-catalog/private',
    'GET /model-catalog/public',
    'PATCH /model-catalog/private/:id',
    'PATCH /model-catalog/public/:id',
    'POST /model-catalog/private',
    'POST /model-catalog/public',
  ]);
});

test('model catalog HTTP API enforces auth, ownership, key handling and safe DTOs',
  { skip: !process.env.DATABASE_URL }, async () => {
  configureEnv();
  const app = buildApp(modelRoutes);
  const suffix = randomUUID();
  const password = 'correct horse battery staple';
  const userIds: string[] = [];
  const publicIds: string[] = [];

  const body = (name: string, overrides: Record<string, unknown> = {}) => ({
    displayName: name,
    providerId: `prov-${suffix}`,
    modelId: `model-${name}`,
    baseUrl: `${FIXTURE_ORIGIN}/v1`,
    apiKey: FIXTURE_KEY,
    ...overrides,
  });
  const call = async (method: string, path: string, token?: string, json?: unknown, raw?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (json !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const response = await app.request(path, {
      method, headers, body: raw ?? (json === undefined ? undefined : JSON.stringify(json)),
    });
    const text = await response.text();
    assert.ok(!text.includes(FIXTURE_KEY), `${method} ${path} leaked fixture key`);
    assert.ok(!text.includes(NEW_KEY), `${method} ${path} leaked replacement key`);
    assert.ok(!text.toLowerCase().includes('ciphertext'), `${method} ${path} leaked ciphertext field`);
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };

  try {
    const admin = await createUser({ email: `admin-${suffix}@example.test`, displayName: 'Admin', password, role: 'admin' });
    const userA = await createUser({ email: `a-${suffix}@example.test`, displayName: 'A', password, role: 'user' });
    const userB = await createUser({ email: `b-${suffix}@example.test`, displayName: 'B', password, role: 'user' });
    userIds.push(admin.id, userA.id, userB.id);
    const tokenOf = async (email: string) => (await login(email, password))!.token;
    const adminToken = await tokenOf(`admin-${suffix}@example.test`);
    const tokenA = await tokenOf(`a-${suffix}@example.test`);
    const tokenB = await tokenOf(`b-${suffix}@example.test`);

    // authentication
    for (const [method, path] of [
      ['GET', '/model-catalog'], ['GET', '/model-catalog/private'], ['POST', '/model-catalog/private'],
      ['PATCH', `/model-catalog/private/${randomUUID()}`], ['DELETE', `/model-catalog/private/${randomUUID()}`],
      ['GET', '/model-catalog/public'], ['POST', '/model-catalog/public'],
    ]) {
      const res = await call(method, path, undefined, method === 'GET' || method === 'DELETE' ? undefined : {});
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(typeof res.json.error, 'string');
    }
    assert.equal((await call('GET', '/model-catalog', 'not-a-real-token')).status, 401);

    // public scope is admin only
    const forbiddenPost = await call('POST', '/model-catalog/public', tokenA, body('nope'));
    assert.equal(forbiddenPost.status, 403);
    assert.equal(typeof forbiddenPost.json.error, 'string');
    assert.equal((await call('GET', '/model-catalog/public', tokenA)).status, 403);
    assert.equal((await call('PATCH', `/model-catalog/public/${randomUUID()}`, tokenA, { enabled: false })).status, 403);
    assert.equal((await call('DELETE', `/model-catalog/public/${randomUUID()}`, tokenA)).status, 403);

    // public create / list
    const createdPublic = await call('POST', '/model-catalog/public', adminToken, body('pub1'));
    assert.equal(createdPublic.status, 201);
    const publicModel = createdPublic.json.model;
    publicIds.push(publicModel.ref.slice('public:'.length));
    assert.equal(publicModel.scope, 'public');
    assert.equal(publicModel.hasApiKey, true);
    assert.equal(publicModel.keyHint, '1234');
    const disabledPublic = await call('POST', '/model-catalog/public', adminToken, body('pub2', { enabled: false }));
    assert.equal(disabledPublic.status, 201);
    publicIds.push(disabledPublic.json.model.ref.slice('public:'.length));

    const managedPublic = await call('GET', '/model-catalog/public', adminToken);
    assert.equal(managedPublic.status, 200);
    const managedRefs = managedPublic.json.models.map((m: { ref: string }) => m.ref);
    assert.ok(managedRefs.includes(publicModel.ref));
    assert.ok(managedRefs.includes(disabledPublic.json.model.ref), 'management list includes disabled');

    // private create / selectable catalog
    const createdPrivate = await call('POST', '/model-catalog/private', tokenA, body('priv1'));
    assert.equal(createdPrivate.status, 201);
    const privateA = createdPrivate.json.model;
    assert.equal(privateA.scope, 'private');
    assert.equal(privateA.isDefault, undefined);
    const privateDisabled = await call('POST', '/model-catalog/private', tokenA, body('priv2', { enabled: false }));
    assert.equal(privateDisabled.status, 201);

    const catalogA = await call('GET', '/model-catalog', tokenA);
    assert.equal(catalogA.status, 200);
    const catalogRefsA = catalogA.json.models.map((m: { ref: string }) => m.ref);
    assert.ok(catalogRefsA.includes(publicModel.ref));
    assert.ok(catalogRefsA.includes(privateA.ref));
    assert.ok(!catalogRefsA.includes(disabledPublic.json.model.ref), 'selectable catalog hides disabled public');
    assert.ok(!catalogRefsA.includes(privateDisabled.json.model.ref), 'selectable catalog hides disabled private');
    const catalogRefsB = (await call('GET', '/model-catalog', tokenB)).json.models.map((m: { ref: string }) => m.ref);
    assert.ok(!catalogRefsB.includes(privateA.ref), 'private model hidden from other users');

    const managedPrivate = await call('GET', '/model-catalog/private', tokenA);
    assert.equal(managedPrivate.status, 200);
    const managedPrivateRefs = managedPrivate.json.models.map((m: { ref: string }) => m.ref);
    assert.ok(managedPrivateRefs.includes(privateA.ref));
    assert.ok(managedPrivateRefs.includes(privateDisabled.json.model.ref), 'private management list includes disabled');
    assert.deepEqual((await call('GET', '/model-catalog/private', tokenB)).json.models, []);

    // validation
    assert.equal((await call('POST', '/model-catalog/private', tokenA, body('bad', { apiKey: '' }))).status, 400);
    const noKey = body('nokey') as Record<string, unknown>;
    delete noKey.apiKey;
    assert.equal((await call('POST', '/model-catalog/private', tokenA, noKey)).status, 400);
    assert.equal((await call('POST', '/model-catalog/private', tokenA, body('bad', { extra: 1 }))).status, 400);
    assert.equal((await call('POST', '/model-catalog/private', tokenA, undefined, '{not json')).status, 400);
    assert.equal((await call('POST', '/model-catalog/private', tokenA, [1, 2])).status, 400);
    assert.equal((await call('POST', '/model-catalog/private', tokenA, undefined, 'null')).status, 400);
    assert.equal((await call('POST', '/model-catalog/private', tokenA, body('big', { displayName: 'x'.repeat(100_000) }))).status, 400);
    assert.equal((await call('POST', '/model-catalog/private', tokenA, body('http', { baseUrl: 'http://models.example.test/v1' }))).status, 400);

    // PATCH: omitted apiKey keeps stored key, empty apiKey is rejected
    const patched = await call('PATCH', `/model-catalog/private/${privateA.ref.slice('private:'.length)}`, tokenA,
      { displayName: 'Renamed' });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.model.displayName, 'Renamed');
    assert.equal(patched.json.model.hasApiKey, true);
    assert.equal(patched.json.model.keyHint, '1234');
    const record = await findAuthorizedModel(privateA.ref, userA);
    assert.equal(decryptApiKey(record.apiKeyCiphertext), FIXTURE_KEY);

    const emptyKey = await call('PATCH', `/model-catalog/private/${privateA.ref.slice('private:'.length)}`, tokenA, { apiKey: '' });
    assert.equal(emptyKey.status, 400);
    assert.equal(decryptApiKey((await findAuthorizedModel(privateA.ref, userA)).apiKeyCiphertext), FIXTURE_KEY);

    const replaced = await call('PATCH', `/model-catalog/private/${privateA.ref.slice('private:'.length)}`, tokenA, { apiKey: NEW_KEY });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.json.model.keyHint, '5678');
    assert.equal(decryptApiKey((await findAuthorizedModel(privateA.ref, userA)).apiKeyCiphertext), NEW_KEY);

    // ownership: foreign private records are indistinguishable from missing ones
    const privateId = privateA.ref.slice('private:'.length);
    const missing = await call('PATCH', `/model-catalog/private/${randomUUID()}`, tokenB, { displayName: 'x' });
    const foreignPatch = await call('PATCH', `/model-catalog/private/${privateId}`, tokenB, { displayName: 'Hijack' });
    assert.equal(foreignPatch.status, 404);
    assert.deepEqual(foreignPatch.json, missing.json);
    const foreignDelete = await call('DELETE', `/model-catalog/private/${privateId}`, tokenB);
    assert.equal(foreignDelete.status, 404);
    assert.equal((await call('PATCH', '/model-catalog/private/not-a-uuid', tokenA, { displayName: 'x' })).status, 404);
    assert.equal((await call('GET', '/model-catalog/private', tokenA)).json.models
      .find((m: { ref: string }) => m.ref === privateA.ref).displayName, 'Renamed');

    // public update and delete by admin
    const publicId = publicModel.ref.slice('public:'.length);
    const disabled = await call('PATCH', `/model-catalog/public/${publicId}`, adminToken, { enabled: false });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.model.enabled, false);
    assert.equal((await call('PATCH', `/model-catalog/public/${randomUUID()}`, adminToken, { enabled: false })).status, 404);
    assert.equal((await call('DELETE', `/model-catalog/public/${publicId}`, adminToken)).status, 200);
    assert.equal((await call('DELETE', `/model-catalog/public/${publicId}`, adminToken)).status, 404);

    // owner delete
    const deleted = await call('DELETE', `/model-catalog/private/${privateId}`, tokenA);
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json, { ok: true });
    assert.equal((await call('DELETE', `/model-catalog/private/${privateId}`, tokenA)).status, 404);
  } finally {
    const pool = getPool();
    if (publicIds.length) await pool.query('DELETE FROM app_public_models WHERE id = ANY($1::uuid[])', [publicIds]);
    if (userIds.length) await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [userIds]);
    await pool.end();
  }
});
