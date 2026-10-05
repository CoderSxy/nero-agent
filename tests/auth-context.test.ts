import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import { resourceIdFor, trustedAuth } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';

const MASTRA_USER_KEY = 'mastra__user';
const USER_ID = '73ff1799-b0e1-4bce-92d0-579061494064';
const FORGED_ID = 'a157a4c1-413f-4d1c-83f1-bbf104573101';

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: USER_ID,
    email: 'user@example.test',
    displayName: '测试用户',
    roles: ['user'],
    ...overrides,
  };
}

function contextOf(entries: Record<string, unknown>) {
  const requestContext = new RequestContext();
  for (const [key, value] of Object.entries(entries)) requestContext.set(key, value);
  return requestContext;
}

test('trustedAuth rejects a missing mastra__user identity', () => {
  assert.throws(() => trustedAuth(new RequestContext()), /unauthenticated|authentication|身份/i);
});

test('trustedAuth rejects a forged mastra__user that is not an AuthUser', () => {
  assert.throws(
    () => trustedAuth(contextOf({ [MASTRA_USER_KEY]: { id: USER_ID } })),
    /unauthenticated|authentication|身份|invalid/i,
  );
});

test('trustedAuth rejects a non-UUID authenticated id', () => {
  assert.throws(
    () => trustedAuth(contextOf({ [MASTRA_USER_KEY]: user({ id: 'local-user' }) })),
    /uuid|invalid/i,
  );
});

test('trustedAuth returns the authenticated UUID and roles from mastra__user', () => {
  const auth = trustedAuth(contextOf({
    [MASTRA_USER_KEY]: user({ roles: ['admin', 'user'] }),
  }));
  assert.equal(auth.userId, USER_ID);
  assert.deepEqual(auth.roles, ['admin', 'user']);
  assert.equal(resourceIdFor(auth), USER_ID);
});

test('trustedAuth ignores client-supplied identity keys including userId', () => {
  assert.throws(
    () => trustedAuth(contextOf({
      userId: FORGED_ID,
      user: user({ id: FORGED_ID, roles: ['admin'] }),
      'nero-agent.trusted-user': user({ id: FORGED_ID }),
    })),
    /unauthenticated|authentication|身份/i,
  );
});

test('trustedAuth prefers mastra__user over client-supplied userId', () => {
  const auth = trustedAuth(contextOf({
    userId: FORGED_ID,
    user: user({ id: FORGED_ID, roles: ['admin'] }),
    [MASTRA_USER_KEY]: user(),
  }));
  assert.equal(auth.userId, USER_ID);
  assert.deepEqual(auth.roles, ['user']);
  assert.equal(resourceIdFor(auth), USER_ID);
});
