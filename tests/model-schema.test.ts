import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { getPool } from '../src/mastra/auth/db';
import { createUser } from '../src/mastra/auth/service';
import { parseModelRef } from '../src/mastra/models/types';

const SAMPLE_PUBLIC_REF = 'public:550e8400-e29b-41d4-a716-446655440000';
const FAKE_CIPHERTEXT = 'v1:test-ciphertext-not-a-real-key';

test('parseModelRef accepts scoped UUIDs only', () => {
  assert.equal(parseModelRef(SAMPLE_PUBLIC_REF)?.scope, 'public');
  assert.equal(parseModelRef(SAMPLE_PUBLIC_REF)?.id, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(parseModelRef('private:550e8400-e29b-41d4-a716-446655440000')?.scope, 'private');
  assert.equal(parseModelRef('openai/gpt'), null);
  assert.equal(parseModelRef('public:not-a-uuid'), null);
  assert.equal(parseModelRef(null), null);
});

test('model catalog tables enforce ownership and default uniqueness',
  { skip: !process.env.DATABASE_URL }, async () => {
  const suffix = randomUUID();
  const email = `model-schema-${suffix}@example.test`;
  const createdUserIds: string[] = [];
  const createdPublicIds: string[] = [];
  const createdPrivateIds: string[] = [];
  const pool = getPool();
  try {
    const user = await createUser({
      email,
      displayName: 'Model Schema User',
      password: 'correct horse battery staple',
      role: 'user',
    });
    createdUserIds.push(user.id);

    const hasExistingDefault = (await pool.query(
      'SELECT 1 FROM app_public_models WHERE is_default LIMIT 1',
    )).rowCount !== 0;

    const publicInsert = await pool.query(
      `INSERT INTO app_public_models (
        display_name, provider_id, model_id, base_url, api_key_ciphertext, is_default
      ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      ['Public Default', 'openai', 'gpt-4o-mini', 'https://api.openai.com/v1', FAKE_CIPHERTEXT, !hasExistingDefault],
    );
    createdPublicIds.push(publicInsert.rows[0].id);

    const privateInsert = await pool.query(
      `INSERT INTO app_private_models (
        user_id, display_name, provider_id, model_id, base_url, api_key_ciphertext
      ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [user.id, 'Private Model', 'openai', 'gpt-4o-mini', 'https://api.openai.com/v1', FAKE_CIPHERTEXT],
    );
    createdPrivateIds.push(privateInsert.rows[0].id);

    await assert.rejects(
      () => pool.query(
        `INSERT INTO app_private_models (
          user_id, display_name, provider_id, model_id, base_url, api_key_ciphertext
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), 'Orphan Private', 'openai', 'gpt-4o-mini', 'https://api.openai.com/v1', FAKE_CIPHERTEXT],
      ),
      (error: { code?: string }) => error.code === '23503',
    );

    await assert.rejects(
      () => pool.query(
        `INSERT INTO app_public_models (
          display_name, provider_id, model_id, base_url, api_key_ciphertext, is_default
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        ['Second Default', 'openai', 'gpt-4o', 'https://api.openai.com/v1', FAKE_CIPHERTEXT, true],
      ),
      (error: { code?: string }) => error.code === '23505',
    );
  } finally {
    if (createdPrivateIds.length) {
      await pool.query('DELETE FROM app_private_models WHERE id = ANY($1::uuid[])', [createdPrivateIds]);
    }
    if (createdPublicIds.length) {
      await pool.query('DELETE FROM app_public_models WHERE id = ANY($1::uuid[])', [createdPublicIds]);
    }
    if (createdUserIds.length) {
      await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [createdUserIds]);
    }
    await pool.end();
  }
});
