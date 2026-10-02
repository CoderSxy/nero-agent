import { getPool } from './db';
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from './crypto';

export type AppRole = 'admin' | 'user';
export type AuthUser = { id: string; email: string; displayName: string; roles: AppRole[] };

const normalizeEmail = (value: string) => value.trim().toLowerCase();

async function withRoles(row: { id: string; email: string; display_name: string }): Promise<AuthUser> {
  const result = await getPool().query<{ code: AppRole }>(
    `SELECT r.code FROM app_roles r JOIN app_user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = $1 ORDER BY r.code`, [row.id]);
  return { id: row.id, email: row.email, displayName: row.display_name,
    roles: result.rows.map(role => role.code) };
}

export async function createUser(input: { email: string; displayName: string; password: string; role: AppRole }): Promise<AuthUser> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw new Error('邮箱格式无效');
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 100) throw new Error('用户名长度须为 1 至 100 位');
  if (input.role !== 'admin' && input.role !== 'user') throw new Error('角色无效');
  const passwordHash = await hashPassword(input.password);
  const connection = await getPool().connect();
  try {
    await connection.query('BEGIN');
    const user = await connection.query<{ id: string; email: string; display_name: string }>(
      `INSERT INTO app_users (email, display_name, password_hash) VALUES ($1, $2, $3)
       RETURNING id, email, display_name`, [email, displayName, passwordHash]);
    await connection.query(
      `INSERT INTO app_user_roles (user_id, role_id)
       SELECT $1, id FROM app_roles WHERE code = $2`, [user.rows[0].id, input.role]);
    await connection.query('COMMIT');
    return { id: user.rows[0].id, email, displayName, roles: [input.role] };
  } catch (error) {
    await connection.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') throw new Error('邮箱已被使用');
    throw error;
  } finally { connection.release(); }
}

export async function login(emailInput: string, password: string): Promise<{ token: string; user: AuthUser } | null> {
  const result = await getPool().query<{
    id: string; email: string; display_name: string; password_hash: string; status: string;
  }>('SELECT id, email, display_name, password_hash, status FROM app_users WHERE email = $1',
    [normalizeEmail(emailInput)]);
  const row = result.rows[0];
  if (!row || row.status !== 'active' || !await verifyPassword(password, row.password_hash)) return null;
  const token = createSessionToken();
  await getPool().query(
    `INSERT INTO app_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '7 days')`, [row.id, hashSessionToken(token)]);
  await getPool().query('UPDATE app_users SET last_login_at = now() WHERE id = $1', [row.id]);
  return { token, user: await withRoles(row) };
}

export async function getUserByToken(token: string): Promise<AuthUser | null> {
  if (!token || token.length > 256) return null;
  const result = await getPool().query<{ id: string; email: string; display_name: string }>(
    `SELECT u.id, u.email, u.display_name FROM app_sessions s
     JOIN app_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
       AND u.status = 'active'`, [hashSessionToken(token)]);
  return result.rows[0] ? withRoles(result.rows[0]) : null;
}

export async function logout(token: string): Promise<void> {
  if (token) await getPool().query(
    'UPDATE app_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashSessionToken(token)]);
}
