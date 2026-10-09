import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createStudioAuth } from '../src/mastra/auth/studio';
import { createStudioProxyAuth, createStudioProxyRBAC, studioGatewayAuthorization, studioSessionCookie } from '../src/mastra/auth/studio-proxy';
import { getPool } from '../src/mastra/auth/db';
import { createUser, getUserByToken, login, logout } from '../src/mastra/auth/service';

const admin = { id: 'admin-1', email: 'admin@example.test', displayName: 'Admin', roles: ['admin'] as ('admin' | 'user')[] };
const ordinary = { id: 'user-1', email: 'user@example.test', displayName: 'User', roles: ['user'] as ('admin' | 'user')[] };

test('Studio proxy authenticates only the configured admin through its internal key', async () => {
  const proxy = createStudioProxyAuth('internal-key-that-is-long-enough-to-be-safe', admin);
  const request = new Request('https://agent.example.test/studio-api/auth/capabilities', {
    headers: { Authorization: 'Bearer internal-key-that-is-long-enough-to-be-safe' },
  });
  assert.equal((await proxy.getCurrentUser(request))?.id, admin.id);
  assert.equal((await proxy.getCurrentUser(request))?.name, 'Admin');
  assert.equal((await proxy.authenticateToken('wrong-key', new Request(request.url)))?.id ?? null, null);
  assert.equal(await proxy.authorizeUser(ordinary, request), false);
  const cookie = studioSessionCookie('active-session', true);
  assert.match(cookie, /^nero_studio_gateway=active-session; Path=\/; HttpOnly; Secure; SameSite=Strict;/);
  const findUser = async (token: string) => token === 'active-session' ? admin : ordinary;
  assert.equal(await studioGatewayAuthorization(cookie, admin.id, 'internal-key-that-is-long-enough-to-be-safe', findUser),
    'Bearer internal-key-that-is-long-enough-to-be-safe');
  assert.equal(await studioGatewayAuthorization(studioSessionCookie('other-session', true), admin.id,
    'internal-key-that-is-long-enough-to-be-safe', findUser), null);
  const rbac = createStudioProxyRBAC();
  assert.deepEqual(await rbac.getPermissions(admin), ['*']);
  assert.deepEqual(await rbac.getPermissions(ordinary), []);
});

test('Studio accepts existing admin credentials and rejects ordinary users', async () => {
  const revoked: string[] = [];
  const auth = createStudioAuth({
    login: async email => email === admin.email ? { token: 'admin-token', user: admin } :
      email === ordinary.email ? { token: 'user-token', user: ordinary } : null,
    getUserByToken: async token => token === 'admin-token' ? admin : token === 'user-token' ? ordinary : null,
    logout: async token => { revoked.push(token); },
  });

  const session = await auth.signIn(admin.email, 'password', new Request('http://localhost:4111'));
  assert.equal(session.token, 'admin-token');
  assert.equal(session.user.name, 'Admin');
  assert.match(session.cookies[0], /^nero_studio_session=admin-token; Path=\/api; HttpOnly; SameSite=Lax;/);
  assert.equal(auth.isSignUpEnabled(), false);
  assert.equal((await auth.authenticateToken('admin-token', new Request('http://localhost:4111')))?.id, admin.id);
  assert.equal(await auth.authenticateToken('user-token', new Request('http://localhost:4111')), null);
  assert.equal((await auth.getCurrentUser(new Request('http://localhost:4111', {
    headers: { Authorization: 'Bearer admin-token' },
  })))?.id, admin.id);
  assert.equal(await auth.getCurrentUser(new Request('http://localhost:4111', {
    headers: { Authorization: 'Bearer user-token' },
  })), null);
  const cookieRequest = new Request('http://localhost:4111/api/agents', {
    headers: { Cookie: 'nero_studio_session=admin-token' },
  });
  assert.equal((await auth.authenticateToken('', cookieRequest))?.id, admin.id);
  assert.equal((await auth.getCurrentUser(cookieRequest))?.id, admin.id);
  const cookieWithOldHeader = new Request('http://localhost:4111/api/agents', {
    headers: { Cookie: 'nero_studio_session=admin-token', Authorization: 'Bearer stale-token' },
  });
  assert.equal((await auth.authenticateToken('stale-token', cookieWithOldHeader))?.id, admin.id);
  assert.equal((await auth.getCurrentUser(cookieWithOldHeader))?.id, admin.id);
  assert.equal(auth.getSessionIdFromRequest(cookieRequest), 'admin-token');
  await auth.destroySession('admin-token');
  assert.match(auth.getClearSessionHeaders()['Set-Cookie'], /Max-Age=0/);
  await assert.rejects(() => auth.signIn(ordinary.email, 'password', new Request('http://localhost:4111')));
  await assert.rejects(() => auth.signIn('missing@example.test', 'password', new Request('http://localhost:4111')));
  assert.deepEqual(revoked, ['admin-token', 'user-token']);
});

test('Studio sign-in uses the same database accounts as the agent page',
  { skip: !process.env.DATABASE_URL }, async () => {
    const suffix = randomUUID();
    const password = 'correct horse battery staple';
    const created: string[] = [];
    try {
      const adminUser = await createUser({ email: `studio-admin-${suffix}@example.test`,
        displayName: 'Studio Admin', password, role: 'admin' });
      const normalUser = await createUser({ email: `studio-user-${suffix}@example.test`,
        displayName: 'Studio User', password, role: 'user' });
      created.push(adminUser.id, normalUser.id);

      const auth = createStudioAuth({ login, getUserByToken, logout });
      const adminSession = await auth.signIn(adminUser.email, password, new Request('http://localhost:4111'));
      assert.equal(adminSession.user.id, adminUser.id);
      assert.equal((await getUserByToken(adminSession.token))?.id, adminUser.id);
      await assert.rejects(() => auth.signIn(normalUser.email, password, new Request('http://localhost:4111')));
      await assert.rejects(() => auth.signIn(adminUser.email, 'wrong', new Request('http://localhost:4111')));
    } finally {
      if (created.length) await getPool().query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [created]);
      await getPool().end();
    }
  });
