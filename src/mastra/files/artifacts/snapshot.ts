import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ArtifactMutation, FileFingerprint, WorkspaceSnapshot } from './types';
import { isArtifactPath } from './paths';

export type SnapshotBudget = {
  maxFiles: number;
  maxBytes: number;
  maxMs: number;
};

export const DEFAULT_SNAPSHOT_BUDGET: SnapshotBudget = {
  maxFiles: 5_000,
  maxBytes: 512 * 1024 * 1024,
  maxMs: 10_000,
};

const EXCLUDED_DIR_NAMES = new Set([
  '.runtime',
  '.git',
  '.venv',
  'node_modules',
  '__pycache__',
]);

const HASH_CACHE_USERS = 32;
type CacheEntry = { fingerprint: FileFingerprint };
const hashCacheByUser = new Map<string, Map<string, CacheEntry>>();

function cacheBucket(userKey: string): Map<string, CacheEntry> {
  let bucket = hashCacheByUser.get(userKey);
  if (!bucket) {
    if (hashCacheByUser.size >= HASH_CACHE_USERS) {
      const oldest = hashCacheByUser.keys().next().value;
      if (oldest !== undefined) hashCacheByUser.delete(oldest);
    }
    bucket = new Map();
    hashCacheByUser.set(userKey, bucket);
  } else {
    // LRU touch
    hashCacheByUser.delete(userKey);
    hashCacheByUser.set(userKey, bucket);
  }
  return bucket;
}

function isExcludedDirName(name: string): boolean {
  if (EXCLUDED_DIR_NAMES.has(name)) return true;
  if (name.startsWith('node_modules.incompatible-')) return true;
  return false;
}

function isPlatformTempName(name: string): boolean {
  return /^\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(name);
}

function isThreadTmpPath(rel: string): boolean {
  const parts = rel.split('/');
  return parts.length >= 3 && parts[0] === 'threads' && parts[2] === 'tmp';
}

function asNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

type StatLike = {
  size: number | bigint;
  dev: number | bigint;
  ino: number | bigint;
  mtimeNs?: bigint;
  ctimeNs?: bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
};

function metadataKey(info: StatLike): string {
  const mtimeNs = info.mtimeNs !== undefined
    ? info.mtimeNs.toString()
    : String(Math.trunc(asNumber(info.mtimeMs) * 1e6));
  const ctimeNs = info.ctimeNs !== undefined
    ? info.ctimeNs.toString()
    : String(Math.trunc(asNumber(info.ctimeMs) * 1e6));
  return `${info.dev}:${info.ino}:${asNumber(info.size)}:${mtimeNs}:${ctimeNs}`;
}

function toFingerprint(etag: string, info: StatLike): FileFingerprint {
  return {
    etag,
    size: asNumber(info.size),
    dev: String(info.dev),
    ino: String(info.ino),
    mtimeNs: info.mtimeNs !== undefined
      ? info.mtimeNs.toString()
      : String(Math.trunc(asNumber(info.mtimeMs) * 1e6)),
    ctimeNs: info.ctimeNs !== undefined
      ? info.ctimeNs.toString()
      : String(Math.trunc(asNumber(info.ctimeMs) * 1e6)),
  };
}

async function streamSha256Etag(hostPath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(hostPath)) {
    hash.update(chunk);
  }
  return `"${hash.digest('hex')}"`;
}

export async function fingerprintWorkspaceFile(
  root: string,
  relativePath: string,
  options: { cacheUserKey?: string } = {},
): Promise<{ fingerprint: FileFingerprint | null; missing: boolean; partial: boolean }> {
  if (!isArtifactPath(relativePath)) {
    return { fingerprint: null, missing: false, partial: true };
  }
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { fingerprint: null, missing: false, partial: true };
  }
  const hostPath = join(realRoot, ...relativePath.split('/'));
  try {
    const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (hostPath !== realRoot && !hostPath.startsWith(prefix)) {
      return { fingerprint: null, missing: false, partial: true };
    }
    const info = await lstat(hostPath);
    if (info.isSymbolicLink()) return { fingerprint: null, missing: false, partial: true };
    if (!info.isFile()) return { fingerprint: null, missing: false, partial: true };
    const cache = options.cacheUserKey ? cacheBucket(options.cacheUserKey) : undefined;
    const fingerprint = await fingerprintFile(hostPath, info, cache);
    if (!fingerprint) return { fingerprint: null, missing: false, partial: true };
    return { fingerprint, missing: false, partial: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { fingerprint: null, missing: true, partial: false };
    }
    return { fingerprint: null, missing: false, partial: true };
  }
}

async function fingerprintFile(
  hostPath: string,
  info: Awaited<ReturnType<typeof lstat>>,
  cache: Map<string, CacheEntry> | undefined,
): Promise<FileFingerprint | null> {
  const key = metadataKey(info);
  const cached = cache?.get(hostPath);
  if (cached) {
    const cachedKey = `${cached.fingerprint.dev}:${cached.fingerprint.ino}:${cached.fingerprint.size}:${cached.fingerprint.mtimeNs}:${cached.fingerprint.ctimeNs}`;
    if (cachedKey === key) return cached.fingerprint;
  }

  const handle = await open(hostPath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) return null;
    const etag = await streamSha256Etag(hostPath);
    const after = await handle.stat();
    if (
      before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || String(before.ino) !== String(after.ino)
    ) {
      return null;
    }
    const fingerprint = toFingerprint(etag, after);
    if (cache) cache.set(hostPath, { fingerprint });
    return fingerprint;
  } finally {
    await handle.close();
  }
}

export type SnapshotOptions = {
  signal?: AbortSignal;
  budget?: SnapshotBudget;
  /** Isolate hash cache per user; omit for anonymous/local tests. */
  cacheUserKey?: string;
  /** Paths known missing via safe ENOENT reads (merged into confirmedMissing). */
  confirmedMissing?: Iterable<string>;
};

/**
 * Walk a personal workspace root and fingerprint ordinary files under budget.
 * Symlinks and excluded dirs are skipped. Over-budget scans return status=partial.
 */
export async function snapshotWorkspace(
  root: string,
  options: SnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const budget = options.budget ?? DEFAULT_SNAPSHOT_BUDGET;
  const started = Date.now();
  const files = new Map<string, FileFingerprint>();
  const confirmedMissing = new Set<string>(options.confirmedMissing ?? []);
  let status: WorkspaceSnapshot['status'] = 'complete';
  let candidates = 0;
  let bytesRead = 0;

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { files, confirmedMissing, status: 'partial' };
  }

  const cache = options.cacheUserKey ? cacheBucket(options.cacheUserKey) : undefined;

  const stack: string[] = [realRoot];
  while (stack.length > 0) {
    if (options.signal?.aborted) {
      status = 'partial';
      break;
    }
    if (Date.now() - started > budget.maxMs) {
      status = 'partial';
      break;
    }
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      status = 'partial';
      continue;
    }

    for (const entry of entries) {
      if (options.signal?.aborted || Date.now() - started > budget.maxMs) {
        status = 'partial';
        break;
      }
      if (isPlatformTempName(entry.name)) continue;
      if (entry.isDirectory() && isExcludedDirName(entry.name)) continue;

      const full = join(current, entry.name);
      let info;
      try {
        info = await lstat(full);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;

      const rel = relative(realRoot, full).split(sep).join('/');
      if (!rel || rel.startsWith('..')) continue;
      if (isThreadTmpPath(rel)) {
        if (info.isDirectory()) continue;
        continue;
      }

      if (info.isDirectory()) {
        // Skip excluded directory names already handled; also skip thread tmp roots
        if (rel.match(/^threads\/[^/]+\/tmp$/)) continue;
        stack.push(full);
        continue;
      }
      if (!info.isFile()) continue;
      if (!isArtifactPath(rel)) continue;

      candidates += 1;
      if (candidates > budget.maxFiles) {
        status = 'partial';
        break;
      }
      if (bytesRead + info.size > budget.maxBytes) {
        status = 'partial';
        continue;
      }

      const fingerprint = await fingerprintFile(full, info, cache);
      if (!fingerprint) {
        status = 'partial';
        continue;
      }
      bytesRead += fingerprint.size;
      files.set(rel, fingerprint);
    }
  }

  return { files, confirmedMissing, status };
}

/**
 * Diff two snapshots into mutations. Partial snapshots never invent created/deleted
 * for unknown paths — only complete coverage or confirmedMissing may use null.
 */
export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): ArtifactMutation[] {
  const paths = new Set<string>([...before.files.keys(), ...after.files.keys()]);
  for (const path of before.confirmedMissing) paths.add(path);
  for (const path of after.confirmedMissing) paths.add(path);

  const mutations: ArtifactMutation[] = [];
  for (const path of paths) {
    const had = before.files.get(path);
    const has = after.files.get(path);
    const missingBefore = before.confirmedMissing.has(path);
    const missingAfter = after.confirmedMissing.has(path);

    let beforeFp: FileFingerprint | null | undefined = had;
    let afterFp: FileFingerprint | null | undefined = has;

    if (!had) {
      if (missingBefore || before.status === 'complete') beforeFp = null;
      else beforeFp = undefined; // unknown
    }
    if (!has) {
      if (missingAfter || after.status === 'complete') afterFp = null;
      else afterFp = undefined;
    }

    if (beforeFp === undefined || afterFp === undefined) continue;
    if (beforeFp === null && afterFp === null) continue;
    if (beforeFp && afterFp && beforeFp.etag === afterFp.etag) continue;

    mutations.push({ path, before: beforeFp, after: afterFp });
  }
  return mutations;
}

/** Test helper: clear process-local hash cache. */
export function clearArtifactHashCache(): void {
  hashCacheByUser.clear();
}
