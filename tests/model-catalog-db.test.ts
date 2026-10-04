import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { getPool } from '../src/mastra/auth/db';
import { createUser } from '../src/mastra/auth/service';
import {
  createModel,
  deleteModel,
  findAuthorizedModel,
  listManagedModels,
  listSelectableModels,
  matchLegacyPublicModel,
  updateModel,
} from '../src/mastra/models/service';
import { ModelCatalogError, type ModelInput, type ModelRef } from '../src/mastra/models/types';
import { decryptApiKey } from '../src/mastra/models/crypto';

const FIXTURE_ORIGIN = 'https://models.example.test';
const FIXTURE_KEY = 'sk-test-1234';

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

test('model catalog enforces ownership, admin scope, and default invariants',
  { skip: !process.env.DATABASE_URL }, async () => {
  configureEnv();
  const suffix = randomUUID();
  const password = 'correct horse battery staple';
  const userIds: string[] = [];
  const publicIds: string[] = [];
  const previousDefaults = (await getPool().query<{ id: string }>(
    'SELECT id FROM app_public_models WHERE is_default')).rows.map((row) => row.id);
  const input = (name: string, overrides: Partial<ModelInput> = {}): ModelInput => ({
    displayName: name,
    providerId: `prov-${suffix}`,
    modelId: `model-${name}`,
    baseUrl: `${FIXTURE_ORIGIN}/v1`,
    apiKey: FIXTURE_KEY,
    ...overrides,
  });

  try {
    const admin = await createUser({ email: `admin-${suffix}@example.test`, displayName: 'Admin', password, role: 'admin' });
    userIds.push(admin.id);
    const userA = await createUser({ email: `a-${suffix}@example.test`, displayName: 'A', password, role: 'user' });
    userIds.push(userA.id);
    const userB = await createUser({ email: `b-${suffix}@example.test`, displayName: 'B', password, role: 'user' });
    userIds.push(userB.id);

    const publicModel = await createModel('public', admin, input('pub1', { displayName: '  Public One  ' }));
    publicIds.push(publicModel.ref.slice('public:'.length));
    assert.equal(publicModel.scope, 'public');
    assert.equal(publicModel.displayName, 'Public One');
    assert.equal(publicModel.hasApiKey, true);
    assert.equal(publicModel.keyHint, '1234');
    assert.equal(publicModel.baseUrl, `${FIXTURE_ORIGIN}/v1`);
    assert.equal(publicModel.apiMode, 'chat');
    assert.ok(!JSON.stringify(publicModel).includes(FIXTURE_KEY));
    assert.ok(!JSON.stringify(publicModel).toLowerCase().includes('ciphertext'));

    const stored = await getPool().query<{ api_key_ciphertext: string }>(
      'SELECT api_key_ciphertext FROM app_public_models WHERE id = $1', [publicIds[0]]);
    assert.ok(!stored.rows[0].api_key_ciphertext.includes(FIXTURE_KEY));
    assert.equal(decryptApiKey(stored.rows[0].api_key_ciphertext), FIXTURE_KEY);

    await assertCode(createModel('public', userB, input('denied')), 'forbidden');
    await assertCode(listManagedModels('public', userB), 'forbidden');
    await assertCode(createModel('private', userA, input('bad-key', { apiKey: '' })), 'invalid_input');
    await assertCode(createModel('private', userA, input('no-key', { apiKey: undefined })), 'invalid_input');
    await assertCode(createModel('private', userA, input('http', { baseUrl: 'http://models.example.test/v1' })), 'invalid_input');
    await assertCode(createModel('private', userA, input('other-origin', { baseUrl: 'https://evil.example.test/v1' })), 'invalid_input');
    await assertCode(createModel('private', userA, input('bad-provider', { providerId: 'bad provider' })), 'invalid_input');
    await assertCode(createModel('private', userA, input('', { displayName: '   ' })), 'invalid_input');
    await assertCode(createModel('private', userA, input('default-private', { isDefault: true })), 'invalid_input');

    const privateA = await createModel('private', userA, input('priv-a'));
    const privateB = await createModel('private', userB, input('priv-b'));
    assert.equal(privateA.scope, 'private');
    assert.equal(privateA.isDefault, undefined);

    const selectableB = (await listSelectableModels(userB)).map((model) => model.ref);
    assert.ok(selectableB.includes(publicModel.ref));
    assert.ok(selectableB.includes(privateB.ref));
    assert.ok(!selectableB.includes(privateA.ref));

    assert.deepEqual((await listManagedModels('private', userA)).map((model) => model.ref), [privateA.ref]);
    assert.ok((await listManagedModels('public', admin)).some((model) => model.ref === publicModel.ref));

    const privateAId = privateA.ref.slice('private:'.length);
    await assertCode(updateModel('private', privateAId, userB, { displayName: 'hijack' }), 'not_found');
    await assertCode(deleteModel('private', privateAId, userB), 'not_found');
    await assertCode(findAuthorizedModel(privateA.ref, userB), 'not_found');
    await assertCode(updateModel('public', publicIds[0], userB, { displayName: 'hijack' }), 'forbidden');
    await assertCode(deleteModel('public', publicIds[0], userB), 'forbidden');
    await assertCode(findAuthorizedModel('private:not-a-uuid' as ModelRef, userA), 'invalid_input');

    const record = await findAuthorizedModel(privateA.ref, userA);
    assert.equal(decryptApiKey(record.apiKeyCiphertext), FIXTURE_KEY);
    assert.equal(record.userId, userA.id);
    assert.equal((await findAuthorizedModel(publicModel.ref, userB)).id, publicIds[0]);

    const originalCiphertext = record.apiKeyCiphertext;
    const renamed = await updateModel('private', privateAId, userA, { displayName: 'Renamed' });
    assert.equal(renamed.displayName, 'Renamed');
    assert.equal(renamed.keyHint, '1234');
    assert.equal((await findAuthorizedModel(privateA.ref, userA)).apiKeyCiphertext, originalCiphertext);
    await assertCode(updateModel('private', privateAId, userA, { apiKey: '' }), 'invalid_input');
    await assertCode(updateModel('private', privateAId, userA, { apiKey: '   ' }), 'invalid_input');
    assert.equal((await findAuthorizedModel(privateA.ref, userA)).apiKeyCiphertext, originalCiphertext);

    const rotated = await updateModel('private', privateAId, userA, { apiKey: 'sk-test-5678' });
    assert.equal(rotated.keyHint, '5678');
    const rotatedRecord = await findAuthorizedModel(privateA.ref, userA);
    assert.notEqual(rotatedRecord.apiKeyCiphertext, originalCiphertext);
    assert.equal(decryptApiKey(rotatedRecord.apiKeyCiphertext), 'sk-test-5678');

    const disabled = await updateModel('private', privateAId, userA, { enabled: false });
    assert.equal(disabled.enabled, false);
    assert.ok(!(await listSelectableModels(userA)).some((model) => model.ref === privateA.ref));
    assert.ok((await listManagedModels('private', userA)).some((model) => model.ref === privateA.ref));
    await assertCode(findAuthorizedModel(privateA.ref, userA), 'disabled');

    const publicTwo = await createModel('public', admin, input('pub2', { isDefault: true }));
    publicIds.push(publicTwo.ref.slice('public:'.length));
    assert.equal(publicTwo.isDefault, true);
    const switched = await updateModel('public', publicIds[0], admin, { isDefault: true });
    assert.equal(switched.isDefault, true);
    const defaults = await getPool().query<{ id: string }>('SELECT id FROM app_public_models WHERE is_default');
    assert.deepEqual(defaults.rows.map((row) => row.id), [publicIds[0]]);
    await assertCode(updateModel('public', publicIds[0], admin, { enabled: false, isDefault: true }), 'invalid_input');
    const disabledDefault = await updateModel('public', publicIds[0], admin, { enabled: false });
    assert.equal(disabledDefault.isDefault, false);
    assert.ok(!(await listSelectableModels(userB)).some((model) => model.ref === publicModel.ref));
    await assertCode(findAuthorizedModel(publicModel.ref, userB), 'disabled');
    await updateModel('public', publicIds[0], admin, { enabled: true });
    const legacyKey = `prov-${suffix}/model-pub1`;
    assert.equal(await matchLegacyPublicModel(legacyKey), publicModel.ref);
    assert.equal(await matchLegacyPublicModel(`prov-${suffix}/missing`), null);
    assert.equal(await matchLegacyPublicModel('no-slash'), null);

    const duplicate = await createModel('public', admin, input('pub1-dup', { modelId: 'model-pub1' }));
    publicIds.push(duplicate.ref.slice('public:'.length));
    assert.equal(await matchLegacyPublicModel(legacyKey), null);
    await updateModel('public', duplicate.ref.slice('public:'.length), admin, { enabled: false });
    assert.equal(await matchLegacyPublicModel(legacyKey), publicModel.ref);

    await deleteModel('private', privateAId, userA);
    await assertCode(findAuthorizedModel(privateA.ref, userA), 'not_found');
    await assertCode(deleteModel('private', privateAId, userA), 'not_found');
    await deleteModel('public', publicIds[1], admin);
    await assertCode(findAuthorizedModel(publicTwo.ref, userA), 'not_found');
  } finally {
    const pool = getPool();
    if (publicIds.length) await pool.query('DELETE FROM app_public_models WHERE id = ANY($1::uuid[])', [publicIds]);
    if (userIds.length) await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [userIds]);
    if (previousDefaults.length) {
      await pool.query('UPDATE app_public_models SET is_default = true WHERE id = ANY($1::uuid[])', [previousDefaults]);
    }
    await pool.end();
  }
});
