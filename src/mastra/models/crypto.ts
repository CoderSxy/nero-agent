import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ModelCatalogError } from './types';

const PAYLOAD_VERSION = 'v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

let cachedKeyValue: string | undefined;
let cachedKeyBuffer: Buffer | undefined;

function loadEncryptionKey(): Buffer {
  const raw = process.env.MODEL_CONFIG_ENCRYPTION_KEY;
  if (!raw) {
    throw new ModelCatalogError(
      'invalid_input',
      'MODEL_CONFIG_ENCRYPTION_KEY is required for model credential encryption',
    );
  }
  if (cachedKeyValue === raw && cachedKeyBuffer) return cachedKeyBuffer;

  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== KEY_BYTES) {
    throw new ModelCatalogError(
      'invalid_input',
      'MODEL_CONFIG_ENCRYPTION_KEY must be valid Base64 encoding 32 bytes',
    );
  }

  cachedKeyValue = raw;
  cachedKeyBuffer = decoded;
  return decoded;
}

export function encryptApiKey(plain: string): string {
  const key = loadEncryptionKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([nonce, ciphertext, tag]);
  return `${PAYLOAD_VERSION}:${payload.toString('base64url')}`;
}

export function decryptApiKey(ciphertext: string): string {
  const key = loadEncryptionKey();
  const separator = ciphertext.indexOf(':');
  if (separator <= 0) {
    throw new ModelCatalogError('invalid_input', 'Encrypted API key payload is invalid');
  }
  const version = ciphertext.slice(0, separator);
  if (version !== PAYLOAD_VERSION) {
    throw new ModelCatalogError('invalid_input', 'Encrypted API key version is unsupported');
  }

  let payload: Buffer;
  try {
    payload = Buffer.from(ciphertext.slice(separator + 1), 'base64url');
  } catch {
    throw new ModelCatalogError('invalid_input', 'Encrypted API key payload is invalid');
  }
  if (payload.length < NONCE_BYTES + TAG_BYTES) {
    throw new ModelCatalogError('invalid_input', 'Encrypted API key payload is invalid');
  }

  const nonce = payload.subarray(0, NONCE_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const encrypted = payload.subarray(NONCE_BYTES, payload.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new ModelCatalogError('invalid_input', 'Encrypted API key could not be decrypted');
  }
}

export function keyHint(plain: string): string {
  if (plain.length <= 4) return plain;
  return plain.slice(-4);
}
