import { isIP } from 'node:net';
import { ModelCatalogError } from './types';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
]);
// const APPROVED_HTTP_BASE_URL = 'http://101.37.135.116:7864/v1';
const APPROVED_HTTP_BASE_URL = 'https://api.nerosun.cn/v1';

let cachedAllowlistValue: string | undefined;
let cachedAllowlistOrigins: Set<string> | undefined;

function parseAllowlistEntry(entry: string): string {
  if (entry === APPROVED_HTTP_BASE_URL) return entry;
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new ModelCatalogError(
      'invalid_input',
      `MODEL_ENDPOINT_ALLOWLIST entry is not a valid HTTPS origin: ${entry}`,
    );
  }

  if (url.protocol !== 'https:') {
    throw new ModelCatalogError(
      'invalid_input',
      `MODEL_ENDPOINT_ALLOWLIST entry must use HTTPS: ${entry}`,
    );
  }
  if (url.username || url.password) {
    throw new ModelCatalogError(
      'invalid_input',
      `MODEL_ENDPOINT_ALLOWLIST entry must not include credentials: ${entry}`,
    );
  }
  if (url.search) {
    throw new ModelCatalogError(
      'invalid_input',
      `MODEL_ENDPOINT_ALLOWLIST entry must not include a query: ${entry}`,
    );
  }
  if (url.hash) {
    throw new ModelCatalogError(
      'invalid_input',
      `MODEL_ENDPOINT_ALLOWLIST entry must not include a fragment: ${entry}`,
    );
  }

  url.hostname = url.hostname.toLowerCase();
  return url.origin;
}

function parseAllowlist(): Set<string> {
  const raw = process.env.MODEL_ENDPOINT_ALLOWLIST;
  if (!raw || !raw.trim()) {
    throw new ModelCatalogError(
      'invalid_input',
      'MODEL_ENDPOINT_ALLOWLIST is required and must list approved model endpoints',
    );
  }
  if (cachedAllowlistValue === raw && cachedAllowlistOrigins) return cachedAllowlistOrigins;

  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new ModelCatalogError(
      'invalid_input',
      'MODEL_ENDPOINT_ALLOWLIST is required and must list approved model endpoints',
    );
  }

  const origins = new Set(entries.map(parseAllowlistEntry));

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

function hostnameForIpCheck(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function assertBlockedHostname(hostname: string): void {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) {
    throw new ModelCatalogError('invalid_input', 'Model endpoint hostname is not allowed');
  }
  if (lower.endsWith('.localhost') || lower.endsWith('.local')) {
    throw new ModelCatalogError('invalid_input', 'Model endpoint hostname is not allowed');
  }
  if (isBlockedIp(hostnameForIpCheck(hostname))) {
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

  if (url.protocol !== 'https:' && url.toString() !== APPROVED_HTTP_BASE_URL) {
    throw new ModelCatalogError('invalid_input', 'Model endpoint must use HTTPS');
  }

  assertBlockedHostname(url.hostname);
  return url;
}

export async function assertAllowedEndpoint(url: URL): Promise<void> {
  const allowlist = parseAllowlist();
  const entry = url.protocol === 'http:' ? url.toString() : url.origin;
  if (!allowlist.has(entry)) {
    throw new ModelCatalogError('invalid_input', 'Model endpoint is not in the approved allowlist');
  }

  assertBlockedHostname(url.hostname);

  // The provider fetch in transport.ts pins requests to this base URL, rejects
  // redirects, and checks every DNS answer when the connection is opened.
}
