import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const keyLength = 64;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) throw new Error('密码长度须为 12 至 256 位');
  const salt = randomBytes(32).toString('hex');
  const derived = await scrypt(password, salt, keyLength) as Buffer;
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, stored] = encoded.split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{64}$/.test(salt || '') ||
      !/^[a-f0-9]{128}$/.test(stored || '')) return false;
  const derived = await scrypt(password, salt, keyLength) as Buffer;
  return timingSafeEqual(derived, Buffer.from(stored, 'hex'));
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
