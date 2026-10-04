import { isIP } from 'node:net';
import { ModelCatalogError } from './types';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
]);

let cachedAllowlistValue: string | undefined;
let cachedAllowlistOrigins: Set<string> | undefined;

function parseAllowlist(): Set<string> {
  const raw = process.env.MODEL_ENDPOINT_ALLOWLIST;
  if (!raw || !raw.trim()) {
    throw new ModelCatalogError(
      'invalid_input',
      'MODEL_ENDPOINT_ALLOWLIST is required and must list approved HTTPS origins',
    );
  }
  if (cachedAllowlistValue === raw && cachedAllowlistOrigins) return cachedAllowlistOrigins;

  const origins = new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  if (origins.size === 0) {
    throw new ModelCatalogError(
      'invalid_input',
      'MODEL_ENDPOINT_ALLOWLIST is required and must list approved HTTPS origins',
    );
  }

  cachedAllowlistValue = raw;
  cachedAllowlistOrigins = origins;
  return origins;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isBlockedIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map((part) => Number(part));
    return isPrivateIpv4(octets);
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fe80:')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length);
      if (isIP(mapped) === 4) return isBlockedIp(mapped);
    }
  }
  return false;
}

function assertBlockedHostname(hostname: string): void {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) {
    throw new ModelCatalogError('invalid_input', 'Model endpoint hostname is not allowed');
  }
  if (lower.endsWith('.localhost') || lower.endsWith('.local')) {
    throw new ModelCatalogError('invalid_input', 'Model endpoint hostname is not allowed');
  }
  if (isBlockedIp(hostname)) {
    throw new ModelCatalogError('invalid_input', 'Model endpoint address is not allowed');
  }
}

export function normalizeModelEndpoint(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ModelCatalogError('invalid_input', 'Model endpoint URL is required');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ModelCatalogError('invalid_input', 'Model endpoint URL is invalid');
  }

  if (url.protocol !== 'https:') {
    throw new ModelCatalogError('invalid_input', 'Model endpoint must use HTTPS');
  }
  if (url.username || url.password) {
    throw new ModelCatalogError('invalid_input', 'Model endpoint URL must not include credentials');
  }
  if (url.hash) {
    throw new ModelCatalogError('invalid_input', 'Model endpoint URL must not include a fragment');
  }

  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  assertBlockedHostname(url.hostname);
  return url;
}

export async function assertAllowedEndpoint(url: URL): Promise<void> {
  const allowlist = parseAllowlist();
  if (!allowlist.has(url.origin)) {
    throw new ModelCatalogError('invalid_input', 'Model endpoint origin is not in the approved allowlist');
  }

  assertBlockedHostname(url.hostname);

  // Redirects to other origins are blocked by restricting outbound calls to
  // approved origins only; model transport must not follow cross-origin redirects.
}
