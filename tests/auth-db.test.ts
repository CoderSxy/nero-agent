import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { getPool } from '../src/mastra/auth/db';
import { createUser, getUserByToken, login, logout } from '../src/mastra/auth/service';

test('admin and normal users log in with separate revocable sessions',
  { skip: !process.env.DATABASE_URL }, async () => {
  const suffix = randomUUID();
  const adminEmail = `admin-${suffix}@example.test`;
  const userEmail = `user-${suffix}@example.test`;
  const password = 'correct horse battery staple';
  const created: string[] = [];
  try {
    const admin = await createUser({ email: adminEmail, displayName: 'Admin', password, role: 'admin' });
    created.push(admin.id);
    const ordinary = await createUser({ email: userEmail, displayName: 'User', password, role: 'user' });
    created.push(ordinary.id);
    assert.deepEqual(admin.roles, ['admin']);
    assert.deepEqual(ordinary.roles, ['user']);
    assert.equal(await login(adminEmail, 'wrong password'), null);
    const adminSession = await login(adminEmail, password);
    const userSession = await login(userEmail, password);
    assert.ok(adminSession && userSession);
    assert.notEqual(adminSession.token, userSession.token);
    assert.equal((await getUserByToken(adminSession.token))?.id, admin.id);
    assert.equal((await getUserByToken(userSession.token))?.id, ordinary.id);
    await logout(adminSession.token);
    assert.equal(await getUserByToken(adminSession.token), null);
    assert.equal((await getUserByToken(userSession.token))?.id, ordinary.id);
  } finally {
    if (created.length) await getPool().query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [created]);
    await getPool().end();
  }
});
