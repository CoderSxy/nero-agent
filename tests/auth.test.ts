import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword, hashSessionToken } from '../src/mastra/auth/crypto';

test('password hashes use unique salts and verify only the matching password', async () => {
  const first = await hashPassword('correct horse battery staple');
  const second = await hashPassword('correct horse battery staple');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('correct horse battery staple', first), true);
  assert.equal(await verifyPassword('wrong password', first), false);
  assert.equal(await verifyPassword('correct horse battery staple', 'malformed'), false);
});

test('session token hashing is deterministic and never stores raw token', () => {
  const token = 'sample-session-token';
  assert.equal(hashSessionToken(token), hashSessionToken(token));
  assert.notEqual(hashSessionToken(token), token);
});
