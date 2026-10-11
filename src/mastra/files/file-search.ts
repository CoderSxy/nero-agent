import { constants } from 'node:fs';
import { open, lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { FileToolScope } from './file-scope';
import { resolveScopedPath } from './file-scope';
import { isWorkspaceText, readWorkspaceVersion } from './workspace-editor';

const DEFAULT_MAX_VISITED = 20_000;
const DEFAULT_MAX_GLOB_RESULTS = 200;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_MAX_GREP_FILES = 500;
const DEFAULT_MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_GREP_TOTAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_GREP_MATCHES = 100;
const DEFAULT_MAX_QUERY_CHARS = 256;
const DEFAULT_MAX_LINE_CHARS = 300;
/** Cap recursive `**` tokens to bound backtracking in {@link matchGlobSegments}. */
const MAX_GLOB_DOUBLE_STAR = 2;

export type WalkedFile = {
  /** Scope-root relative path using `/`. */
  path: string;
  hostPath: string;
  size: number;
};

export type WalkScopedFilesArgs = {
  root: string;
  scope: FileToolScope;
  threadId: string;
  basePath?: string;
  signal?: AbortSignal;
  maxVisited?: number;
  onFile: (file: WalkedFile) => boolean | void | Promise<boolean | void>;
};

export type WalkScopedFilesResult = {
  visitedEntries: number;
  truncated: boolean;
  reason?: string;
};

export type GlobFilesArgs = {
  root: string;
  scope: FileToolScope;
  threadId: string;
  basePath?: string;
  pattern: string;
  signal?: AbortSignal;
  maxResults?: number;
  maxVisited?: number;
  maxOutputBytes?: number;
};

export type GlobFilesResult = {
  entries: Array<{ path: string; size: number }>;
  visitedEntries: number;
  truncated: boolean;
  reason?: string;
};

export type GrepFilesArgs = {
  root: string;
  scope: FileToolScope;
  threadId: string;
  basePath?: string;
  filePattern?: string;
  query: string;
  caseSensitive?: boolean;
  signal?: AbortSignal;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxMatches?: number;
  maxOutputBytes?: number;
  maxVisited?: number;
  maxQueryChars?: number;
  maxLineChars?: number;
  /**
   * Test seam: override byte reads. Production uses {@link readFileCapped}.
   * Results still pass through post-read size / total-byte guards.
   */
  readFileBytes?: (hostPath: string, maxFileBytes: number) => Promise<Buffer>;
};

export type GrepMatch = {
  path: string;
  lineNumber: number;
  line: string;
  lineTruncated: boolean;
  etag: string;
};

export type GrepFilesResult = {
  matches: GrepMatch[];
  scannedFiles: number;
  skippedBinaryFiles: number;
  skippedLargeFiles: number;
  truncated: boolean;
  reason?: string;
};

export class GrepQueryError extends Error {
  readonly code = 'INVALID_QUERY';
  constructor(message = '无效的搜索查询') {
    super(message);
    this.name = 'GrepQueryError';
  }
}

export class GlobPatternError extends Error {
  readonly code = 'INVALID_PATTERN';
  constructor(message = '无效的 glob 模式') {
    super(message);
    this.name = 'GlobPatternError';
  }
}

/** Validate and normalize a glob pattern. Only `*`, `?`, and `**` wildcards are supported. */
export function assertGlobPattern(pattern: string): string {
  if (typeof pattern !== 'string' || !pattern || pattern.includes('\0')) {
    throw new GlobPatternError('无效的 glob 模式');
  }
  if (pattern.includes('\\') || pattern.startsWith('/')) {
    throw new GlobPatternError('无效的 glob 模式');
  }
  if (/[[\]{}()+^$|!]/.test(pattern)) {
    throw new GlobPatternError('无效的 glob 模式：仅支持 * ? **');
  }
  const segments = pattern.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new GlobPatternError('无效的 glob 模式');
  }
  for (const segment of segments) {
    if (segment !== '**' && segment.includes('**')) {
      throw new GlobPatternError('无效的 glob 模式：仅支持 * ? **');
    }
  }
  const doubleStars = segments.filter(segment => segment === '**').length;
  if (doubleStars > MAX_GLOB_DOUBLE_STAR) {
    throw new GlobPatternError(`无效的 glob 模式：最多 ${MAX_GLOB_DOUBLE_STAR} 个 **`);
  }
  return pattern;
}

export function matchGlobPattern(pattern: string, relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\/+/, '');
  return matchGlobSegments(assertGlobPattern(pattern).split('/'), normalized.split('/').filter(Boolean));
}

function matchGlobSegments(patternParts: string[], pathParts: string[]): boolean {
  let pi = 0;
  let si = 0;
  while (pi < patternParts.length) {
    const part = patternParts[pi]!;
    if (part === '**') {
      if (pi === patternParts.length - 1) return true;
      for (let skip = 0; skip <= pathParts.length - si; skip += 1) {
        if (matchGlobSegments(patternParts.slice(pi + 1), pathParts.slice(si + skip))) {
          return true;
        }
      }
      return false;
    }
    if (si >= pathParts.length) return false;
    if (!matchGlobSegment(part, pathParts[si]!)) return false;
    pi += 1;
    si += 1;
  }
  return si === pathParts.length;
}

function matchGlobSegment(pattern: string, segment: string): boolean {
  let pi = 0;
  let si = 0;
  let starPi = -1;
  let starSi = -1;
  while (si < segment.length) {
    const pc = pattern[pi];
    if (pc === '*' && pi < pattern.length) {
      starPi = pi;
      starSi = si;
      pi += 1;
      continue;
    }
    if (pi < pattern.length && (pc === '?' || pc === segment[si])) {
      pi += 1;
      si += 1;
      continue;
    }
    if (starPi !== -1) {
      pi = starPi + 1;
      starSi += 1;
      si = starSi;
      continue;
    }
    return false;
  }
  while (pi < pattern.length && pattern[pi] === '*') pi += 1;
  return pi === pattern.length;
}

function toPosixRelative(root: string, hostPath: string): string {
  const rel = relative(root, hostPath);
  if (!rel || rel === '.') return '';
  return rel.split(sep).join('/');
}

function isForeignThreadPath(scopeRel: string, scope: FileToolScope, threadId: string): boolean {
  if (scope !== 'workspace') return false;
  const segments = scopeRel.split('/').filter(Boolean);
  return segments[0] === 'threads' && segments.length >= 2 && segments[1] !== threadId;
}

/**
 * Deterministic depth-first walk of regular files under a scoped base path.
 * Skips symlinks and foreign `threads/<id>` subtrees. Shared by glob and grep.
 */
export async function walkScopedFiles(args: WalkScopedFilesArgs): Promise<WalkScopedFilesResult> {
  const maxVisited = args.maxVisited ?? DEFAULT_MAX_VISITED;
  const baseHost = await resolveScopedPath(
    args.root,
    args.basePath ?? '',
    args.scope,
    args.threadId,
    { allowRoot: true },
  );

  let visitedEntries = 0;
  let truncated = false;
  let reason: string | undefined;

  const visit = async (dirHost: string): Promise<boolean> => {
    if (args.signal?.aborted) {
      truncated = true;
      reason = '搜索已中断（abort）';
      return false;
    }

    let dirents;
    try {
      dirents = await readdir(dirHost, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }

    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const dirent of dirents) {
      if (args.signal?.aborted) {
        truncated = true;
        reason = '搜索已中断（abort）';
        return false;
      }

      if (visitedEntries >= maxVisited) {
        truncated = true;
        reason = `已达遍历上限（${maxVisited} visited）`;
        return false;
      }

      visitedEntries += 1;
      const hostPath = join(dirHost, dirent.name);
      const scopeRel = toPosixRelative(args.root, hostPath);

      let info;
      try {
        info = await lstat(hostPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }

      if (info.isSymbolicLink()) continue;

      if (info.isDirectory()) {
        if (isForeignThreadPath(scopeRel, args.scope, args.threadId)) continue;
        const cont = await visit(hostPath);
        if (!cont) return false;
        continue;
      }

      if (!info.isFile()) continue;

      const shouldContinue = await args.onFile({
        path: scopeRel,
        hostPath,
        size: info.size,
      });
      if (shouldContinue === false) return false;
    }

    return true;
  };

  if (args.signal?.aborted) {
    return { visitedEntries: 0, truncated: true, reason: '搜索已中断（abort）' };
  }

  await visit(baseHost);
  return { visitedEntries, truncated, reason };
}

export async function globFiles(args: GlobFilesArgs): Promise<GlobFilesResult> {
  const pattern = assertGlobPattern(args.pattern);
  const maxResults = args.maxResults ?? DEFAULT_MAX_GLOB_RESULTS;
  const maxOutputBytes = args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const basePrefix = args.basePath ?? '';

  const entries: Array<{ path: string; size: number }> = [];
  let stopReason: string | undefined;

  const walk = await walkScopedFiles({
    root: args.root,
    scope: args.scope,
    threadId: args.threadId,
    basePath: args.basePath,
    signal: args.signal,
    maxVisited: args.maxVisited,
    onFile: file => {
      const matchPath = basePrefix
        ? file.path === basePrefix
          ? ''
          : file.path.startsWith(`${basePrefix}/`)
            ? file.path.slice(basePrefix.length + 1)
            : null
        : file.path;
      if (matchPath === null) return;
      if (!matchGlobPattern(pattern, matchPath)) return;

      if (entries.length >= maxResults) {
        stopReason = `已达结果上限（${maxResults} results）`;
        return false;
      }

      const next = { path: file.path, size: file.size };
      const serialized = Buffer.byteLength(JSON.stringify([...entries, next]), 'utf8');
      if (serialized > maxOutputBytes) {
        stopReason = `已达输出上限（${maxOutputBytes} bytes）`;
        return false;
      }

      entries.push(next);
    },
  });

  const truncated = walk.truncated || Boolean(stopReason);
  const reason = stopReason ?? walk.reason;
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    entries,
    visitedEntries: walk.visitedEntries,
    truncated,
    ...(reason ? { reason } : {}),
  };
}

function unicodeLength(value: string): number {
  return [...value].length;
}

function clipUnicode(
  value: string,
  query: string,
  caseSensitive: boolean,
  maxChars: number,
): { text: string; truncated: boolean } {
  const chars = [...value];
  if (chars.length <= maxChars) return { text: value, truncated: false };
  const matchOffset = caseSensitive
    ? value.indexOf(query)
    : value.toLowerCase().indexOf(query.toLowerCase());
  let matchStart = 0;
  if (caseSensitive) {
    matchStart = [...value.slice(0, matchOffset)].length;
  } else {
    // Lowercasing may expand a character (e.g. İ -> i + combining dot), so
    // offsets in the folded string cannot be used to slice the original line.
    let foldedOffset = 0;
    for (const char of chars) {
      if (foldedOffset >= matchOffset) break;
      foldedOffset += char.toLowerCase().length;
      matchStart += 1;
    }
  }
  const contextBefore = Math.max(0, Math.floor((maxChars - unicodeLength(query)) / 2));
  const start = Math.max(0, Math.min(matchStart - contextBefore, chars.length - maxChars));
  return { text: chars.slice(start, start + maxChars).join(''), truncated: true };
}

function assertGrepQuery(query: string, maxQueryChars: number): string {
  if (typeof query !== 'string' || !query || query.includes('\0')) {
    throw new GrepQueryError('无效的搜索查询');
  }
  if (unicodeLength(query) > maxQueryChars) {
    throw new GrepQueryError(`查询过长：最多 ${maxQueryChars} 个 Unicode 字符`);
  }
  return query;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function lineContainsLiteral(line: string, query: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return line.includes(query);
  return line.toLowerCase().includes(query.toLowerCase());
}

/**
 * Read at most `maxBytes + 1` so callers can detect oversize without unbounded I/O.
 * Spec: grep may scan at most 2 MiB per file after the size check.
 * Uses O_NOFOLLOW so a TOCTOU swap to a symlink cannot redirect the read outside the root.
 */
export async function readFileCapped(hostPath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(hostPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      const error = new Error('Not a regular file') as NodeJS.ErrnoException;
      error.code = 'EINVAL';
      throw error;
    }
    const capacity = Math.max(0, maxBytes) + 1;
    const buffer = Buffer.allocUnsafe(capacity);
    const { bytesRead } = await handle.read(buffer, 0, capacity, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function grepFiles(args: GrepFilesArgs): Promise<GrepFilesResult> {
  const maxQueryChars = args.maxQueryChars ?? DEFAULT_MAX_QUERY_CHARS;
  const query = assertGrepQuery(args.query, maxQueryChars);
  const caseSensitive = args.caseSensitive ?? true;
  const filePattern = assertGlobPattern(args.filePattern ?? '**/*');
  const maxFiles = args.maxFiles ?? DEFAULT_MAX_GREP_FILES;
  const maxFileBytes = args.maxFileBytes ?? DEFAULT_MAX_GREP_FILE_BYTES;
  const maxTotalBytes = args.maxTotalBytes ?? DEFAULT_MAX_GREP_TOTAL_BYTES;
  const maxMatches = args.maxMatches ?? DEFAULT_MAX_GREP_MATCHES;
  const maxOutputBytes = args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxLineChars = args.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const basePrefix = args.basePath ?? '';

  const matches: GrepMatch[] = [];
  let scannedFiles = 0;
  let skippedBinaryFiles = 0;
  let skippedLargeFiles = 0;
  let totalBytes = 0;
  let stopReason: string | undefined;

  const walk = await walkScopedFiles({
    root: args.root,
    scope: args.scope,
    threadId: args.threadId,
    basePath: args.basePath,
    signal: args.signal,
    maxVisited: args.maxVisited,
    onFile: async file => {
      const matchPath = basePrefix
        ? file.path === basePrefix
          ? ''
          : file.path.startsWith(`${basePrefix}/`)
            ? file.path.slice(basePrefix.length + 1)
            : null
        : file.path;
      if (matchPath === null) return;
      if (!matchGlobPattern(filePattern, matchPath)) return;

      if (scannedFiles >= maxFiles) {
        stopReason = `已达扫描文件上限（${maxFiles} files）`;
        return false;
      }

      // Pre-check via lstat avoids opening known-huge files; post-read guards below
      // cover TOCTOU growth and enforce budgets on actual bytes read.
      if (file.size > maxFileBytes) {
        skippedLargeFiles += 1;
        return;
      }

      if (totalBytes + file.size > maxTotalBytes) {
        stopReason = `已达总读取上限（${maxTotalBytes} bytes）`;
        return false;
      }

      let bytes: Buffer;
      try {
        bytes = args.readFileBytes
          ? await args.readFileBytes(file.hostPath, maxFileBytes)
          : await readFileCapped(file.hostPath, maxFileBytes);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // ENOENT / ELOOP / EINVAL: vanished, became a symlink, or not a regular file (TOCTOU).
        if (code === 'ENOENT' || code === 'ELOOP' || code === 'EINVAL') return;
        throw error;
      }

      // Post-read: never scan text when actual payload exceeds per-file cap.
      if (bytes.byteLength > maxFileBytes) {
        skippedLargeFiles += 1;
        return;
      }

      // Post-read: totalBytes must use actual length, not stale lstat size.
      if (totalBytes + bytes.byteLength > maxTotalBytes) {
        stopReason = `已达总读取上限（${maxTotalBytes} bytes）`;
        return false;
      }

      scannedFiles += 1;
      totalBytes += bytes.byteLength;

      if (!isWorkspaceText(bytes)) {
        skippedBinaryFiles += 1;
        return;
      }

      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const etag = readWorkspaceVersion(bytes);
      const lines = splitLines(text);

      for (let i = 0; i < lines.length; i += 1) {
        const rawLine = lines[i]!;
        if (!lineContainsLiteral(rawLine, query, caseSensitive)) continue;

        if (matches.length >= maxMatches) {
          stopReason = `已达命中上限（${maxMatches} matches）`;
          return false;
        }

        const clipped = clipUnicode(rawLine, query, caseSensitive, maxLineChars);
        const next: GrepMatch = {
          path: file.path,
          lineNumber: i + 1,
          line: clipped.text,
          lineTruncated: clipped.truncated,
          etag,
        };
        const serialized = Buffer.byteLength(JSON.stringify([...matches, next]), 'utf8');
        if (serialized > maxOutputBytes) {
          stopReason = `已达输出上限（${maxOutputBytes} bytes）`;
          return false;
        }
        matches.push(next);
      }
    },
  });

  const truncated = walk.truncated || Boolean(stopReason);
  const reason = stopReason ?? walk.reason;
  matches.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return a.lineNumber - b.lineNumber;
  });

  return {
    matches,
    scannedFiles,
    skippedBinaryFiles,
    skippedLargeFiles,
    truncated,
    ...(reason ? { reason } : {}),
  };
}
