import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  BlobReader,
  ZipReader,
  type Entry,
} from '@zip.js/zip.js';
import { getSkillsImportTempRoot, getSkillsImportTtlMs } from './config';
import { SkillPackageError } from './errors';
import type {
  SkillImportPreview,
  SkillPackageFile,
  SkillResource,
  SkillRuntimeManifest,
  ValidatedSkillPackage,
} from './types';
import {
  SKILL_LIMITS,
  assertWithinFileCount,
  assertWithinFileLimit,
  assertWithinVersionTotal,
  decodeUtf8Strict,
  looksLikeText,
  normalizeSkillPath,
  parseSkillFrontmatterYaml,
  pathCollisionKey,
  suggestCanonicalName,
  validateSkillMd,
} from './validation';

export { SKILL_LIMITS, validateSkillMd } from './validation';
export type {
  SkillImportPreview,
  SkillMdValidationResult,
  SkillPackageFile,
  SkillResource,
  SkillRuntimeManifest,
  ValidatedSkillPackage,
} from './types';
export { SkillPackageError } from './errors';
export { getSkillsImportTempRoot, getSkillsImportTtlMs } from './config';

const UNIX_S_IFMT = 0o170000;
const UNIX_S_IFREG = 0o100000;
const UNIX_S_IFDIR = 0o040000;
const UNIX_S_IFLNK = 0o120000;
const UNIX_S_IFCHR = 0o020000;
const UNIX_S_IFBLK = 0o060000;
const UNIX_S_IFIFO = 0o010000;
const UNIX_S_IFSOCK = 0o140000;

const RUNTIME_NETWORKS = new Set(['none', 'server-tools']);
const RUNTIME_RUNTIMES = new Set(['python3', 'node', 'bash']);

function unixModeOf(entry: Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function assertZipEntryAllowed(entry: Entry): void {
  if (entry.comment && /^hardlink:/i.test(entry.comment)) {
    throw new SkillPackageError('PATH_HARDLINK', `Hardlink entries are not allowed: ${entry.filename}`);
  }
  if (entry.symlink || (unixModeOf(entry) & UNIX_S_IFMT) === UNIX_S_IFLNK) {
    throw new SkillPackageError('PATH_SYMLINK', `Symlink entries are not allowed: ${entry.filename}`);
  }
  if (entry.directory) return;
  const type = unixModeOf(entry) & UNIX_S_IFMT;
  if (type === 0 || type === UNIX_S_IFREG) return;
  if (type === UNIX_S_IFDIR) return;
  if (type === UNIX_S_IFCHR || type === UNIX_S_IFBLK || type === UNIX_S_IFIFO || type === UNIX_S_IFSOCK) {
    throw new SkillPackageError('PATH_SPECIAL_FILE', `Special file entries are not allowed: ${entry.filename}`);
  }
  throw new SkillPackageError('PATH_SPECIAL_FILE', `Unsupported file type in zip entry: ${entry.filename}`);
}

function stripOuterWrapper(paths: string[]): { prefix: string; stripped: Map<string, string> } {
  const normalized = paths.map(p => normalizeSkillPath(p));
  const skillMdPaths = normalized.filter(p => p === 'SKILL.md' || p.endsWith('/SKILL.md'));
  if (skillMdPaths.length === 0) {
    throw new SkillPackageError('SKILL_MD_MISSING', 'SKILL.md is required at the skill package root');
  }
  if (skillMdPaths.length > 1) {
    // Allow unwrap only when every SKILL.md shares one outer directory segment.
    const tops = new Set(skillMdPaths.map(p => p.split('/')[0]!));
    if (tops.size !== 1 || skillMdPaths.some(p => p === 'SKILL.md')) {
      throw new SkillPackageError('SKILL_MD_AMBIGUOUS', 'Multiple SKILL.md roots found');
    }
  }

  const hasRootSkill = normalized.includes('SKILL.md');
  if (hasRootSkill) {
    if (skillMdPaths.length > 1) {
      throw new SkillPackageError('SKILL_MD_AMBIGUOUS', 'Multiple SKILL.md roots found');
    }
    return { prefix: '', stripped: new Map(normalized.map(p => [p, p])) };
  }

  // One outer wrapper: all paths share the same first segment, and `<wrap>/SKILL.md` exists.
  const firstSegments = new Set(normalized.map(p => p.split('/')[0]!));
  if (firstSegments.size !== 1) {
    throw new SkillPackageError('SKILL_MD_AMBIGUOUS', 'Multiple SKILL.md roots found');
  }
  const prefix = [...firstSegments][0]!;
  const wrappedSkill = `${prefix}/SKILL.md`;
  if (!normalized.includes(wrappedSkill)) {
    throw new SkillPackageError('SKILL_MD_MISSING', 'SKILL.md is required at the skill package root');
  }
  if (skillMdPaths.some(p => p !== wrappedSkill)) {
    throw new SkillPackageError('SKILL_MD_AMBIGUOUS', 'Multiple SKILL.md roots found');
  }

  const stripped = new Map<string, string>();
  for (const path of normalized) {
    if (!path.startsWith(`${prefix}/`)) {
      throw new SkillPackageError('PATH_INVALID', 'Unexpected path outside wrapper directory');
    }
    const inner = path.slice(prefix.length + 1);
    if (!inner) continue;
    stripped.set(path, inner);
  }
  return { prefix, stripped };
}

export function parseRuntimeManifest(bytes: Uint8Array): SkillRuntimeManifest {
  if (bytes.byteLength > SKILL_LIMITS.JSON_MAX_BYTES) {
    throw new SkillPackageError('JSON_TOO_LARGE', `skill-runtime.json exceeds ${SKILL_LIMITS.JSON_MAX_BYTES} bytes`);
  }
  let text: string;
  try {
    text = decodeUtf8Strict(bytes);
  } catch {
    throw new SkillPackageError('JSON_INVALID', 'skill-runtime.json must be UTF-8 JSON');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SkillPackageError('JSON_INVALID', 'skill-runtime.json is not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillPackageError('JSON_INVALID', 'skill-runtime.json must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new SkillPackageError('RUNTIME_SCHEMA_UNSUPPORTED', `Unsupported skill-runtime schemaVersion: ${String(obj.schemaVersion)}`);
  }
  const runtimes = Array.isArray(obj.runtimes) ? obj.runtimes : [];
  const entrypoints = Array.isArray(obj.entrypoints) ? obj.entrypoints : [];
  const requiredTools = Array.isArray(obj.requiredTools) ? obj.requiredTools : [];
  const network = obj.network;
  if (typeof network !== 'string' || !RUNTIME_NETWORKS.has(network)) {
    throw new SkillPackageError('JSON_INVALID', 'skill-runtime.json network must be none|server-tools');
  }
  for (const runtime of runtimes) {
    if (typeof runtime !== 'string' || !RUNTIME_RUNTIMES.has(runtime)) {
      throw new SkillPackageError('JSON_INVALID', `Unsupported runtime: ${String(runtime)}`);
    }
  }
  for (const entry of entrypoints) {
    if (typeof entry !== 'string') {
      throw new SkillPackageError('JSON_INVALID', 'entrypoint paths must be strings');
    }
    const normalized = normalizeSkillPath(entry);
    if (!normalized.startsWith('scripts/')) {
      throw new SkillPackageError('JSON_INVALID', `entrypoint must be under scripts/: ${entry}`);
    }
  }
  for (const tool of requiredTools) {
    if (typeof tool !== 'string' || !tool) {
      throw new SkillPackageError('JSON_INVALID', 'requiredTools must be non-empty strings');
    }
  }
  return {
    schemaVersion: 1,
    runtimes: runtimes as SkillRuntimeManifest['runtimes'],
    entrypoints: entrypoints as string[],
    requiredTools: requiredTools as string[],
    network: network as SkillRuntimeManifest['network'],
  };
}

export async function parseSkillPackage(
  files: AsyncIterable<{ path: string; bytes: Uint8Array }>,
): Promise<ValidatedSkillPackage> {
  const collected: SkillPackageFile[] = [];
  let totalBytes = 0;

  for await (const file of files) {
    const normalized = normalizeSkillPath(file.path);
    assertWithinFileLimit(file.bytes.byteLength, normalized);
    totalBytes += file.bytes.byteLength;
    assertWithinVersionTotal(totalBytes);
    collected.push({ path: normalized, bytes: file.bytes });
    assertWithinFileCount(collected.length);
  }

  if (collected.length === 0) {
    throw new SkillPackageError('SKILL_MD_MISSING', 'SKILL.md is required at the skill package root');
  }

  const { stripped } = stripOuterWrapper(collected.map(f => f.path));
  const byPath = new Map<string, Uint8Array>();
  const collision = new Map<string, string>();

  for (const file of collected) {
    const inner = stripped.get(file.path);
    if (inner === undefined) continue;
    const key = pathCollisionKey(inner);
    const existing = collision.get(key);
    if (existing && existing !== inner) {
      throw new SkillPackageError('PATH_COLLISION', `Path collision between "${existing}" and "${inner}"`);
    }
    if (byPath.has(inner)) {
      throw new SkillPackageError('PATH_COLLISION', `Duplicate path: ${inner}`);
    }
    collision.set(key, inner);
    byPath.set(inner, file.bytes);
  }

  const skillMdBytes = byPath.get('SKILL.md');
  if (!skillMdBytes) {
    throw new SkillPackageError('SKILL_MD_MISSING', 'SKILL.md is required at the skill package root');
  }
  if (skillMdBytes.byteLength > SKILL_LIMITS.SKILL_MD_MAX_BYTES) {
    throw new SkillPackageError('SKILL_MD_TOO_LARGE', `SKILL.md exceeds ${SKILL_LIMITS.SKILL_MD_MAX_BYTES} bytes`);
  }

  const skillMd = decodeUtf8Strict(skillMdBytes);
  let sourceName = '';
  try {
    const fm = parseSkillFrontmatterYaml(skillMd);
    sourceName = typeof fm.metadata.name === 'string' ? fm.metadata.name : '';
  } catch (err) {
    if (err instanceof SkillPackageError) throw err;
    throw new SkillPackageError('SKILL_MD_INVALID', err instanceof Error ? err.message : 'SKILL.md is invalid');
  }
  // Validate against the package source name (not a rewritten canonical) so names are never silently changed.
  const validated = validateSkillMd(skillMd, sourceName || 'unnamed');

  if (validated.errors.length > 0 || !validated.valid) {
    throw new SkillPackageError('SKILL_MD_INVALID', validated.errors.join('; ') || 'SKILL.md is invalid');
  }
  if (!validated.metadata || typeof validated.metadata.description !== 'string') {
    throw new SkillPackageError('SKILL_MD_INVALID', 'description is required');
  }

  const requiresNameAcceptance = Boolean(validated.requiresNameAcceptance);
  const suggestedCanonicalName = validated.suggestedCanonicalName || suggestCanonicalName(sourceName);
  const canonicalName = requiresNameAcceptance ? '' : sourceName;

  let runtimeManifest: SkillRuntimeManifest | null = null;
  const runtimeBytes = byPath.get('skill-runtime.json');
  if (runtimeBytes) {
    runtimeManifest = parseRuntimeManifest(runtimeBytes);
  }

  const resources: SkillResource[] = [];
  for (const [path, bytes] of byPath) {
    if (path === 'SKILL.md') continue;
    resources.push({
      path,
      bytes,
      size: bytes.byteLength,
      isText: looksLikeText(bytes),
    });
  }
  resources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    canonicalName,
    sourceName,
    suggestedCanonicalName,
    requiresNameAcceptance,
    description: validated.metadata.description,
    skillMd,
    resources,
    runtimeManifest,
    warnings: validated.warnings,
  };
}

async function streamToFileWithLimit(
  stream: ReadableStream<Uint8Array>,
  filePath: string,
  maxBytes: number,
): Promise<number> {
  await mkdir(dirname(filePath), { recursive: true });
  let total = 0;
  const handle = createWriteStream(filePath);
  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.releaseLock();
        handle.destroy();
        await rm(filePath, { force: true }).catch(() => undefined);
        throw new SkillPackageError('ZIP_TOO_LARGE', `ZIP exceeds ${maxBytes} bytes`, 413);
      }
      if (!handle.write(Buffer.from(value))) {
        await new Promise<void>((resolveWait, rejectWait) => {
          const onDrain = () => {
            handle.off('error', onError);
            resolveWait();
          };
          const onError = (error: Error) => {
            handle.off('drain', onDrain);
            rejectWait(error);
          };
          handle.once('drain', onDrain);
          handle.once('error', onError);
        });
      }
    }
    await new Promise<void>((resolveClose, rejectClose) => {
      handle.end(() => resolveClose());
      handle.once('error', rejectClose);
    });
  } catch (err) {
    handle.destroy();
    await rm(filePath, { force: true }).catch(() => undefined);
    throw err;
  }
  return total;
}

async function emptyDirectory(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async entry => {
    await rm(join(dir, entry.name), { recursive: true, force: true });
  }));
}

async function materializePackageLayout(tempRoot: string, pkg: ValidatedSkillPackage): Promise<void> {
  await emptyDirectory(tempRoot);
  await writeFile(join(tempRoot, 'SKILL.md'), pkg.skillMd, 'utf8');
  for (const resource of pkg.resources) {
    const target = resolve(tempRoot, resource.path);
    if (target !== tempRoot && !target.startsWith(tempRoot + '/')) {
      throw new SkillPackageError('PATH_INVALID', 'Resource path escapes import temp root');
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, resource.bytes);
  }
}

async function readEntryBytes(entry: Entry, maxRemaining: number): Promise<Uint8Array> {
  if (entry.directory) {
    throw new SkillPackageError('ZIP_INVALID', `Zip entry has no data: ${entry.filename}`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      total += chunk.byteLength;
      if (total > maxRemaining) {
        throw new SkillPackageError('ZIP_EXPAND_TOO_LARGE', 'Zip expanded size exceeds version budget');
      }
      if (total > SKILL_LIMITS.FILE_MAX_BYTES) {
        throw new SkillPackageError('FILE_TOO_LARGE', `File exceeds ${SKILL_LIMITS.FILE_MAX_BYTES} bytes: ${entry.filename}`);
      }
      chunks.push(chunk);
    },
  });
  await entry.getData!(writable);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Stream-count ZIP upload, inspect entries, extract under a TTL-managed temp root, then parse.
 * On any failure the import directory is removed; nothing is written outside the temp root.
 */
export async function previewSkillZip(stream: ReadableStream<Uint8Array>): Promise<SkillImportPreview> {
  let tempRootBase: string;
  try {
    tempRootBase = getSkillsImportTempRoot();
  } catch (err) {
    throw new SkillPackageError(
      'IMPORT_TEMP_UNAVAILABLE',
      err instanceof Error ? err.message : 'Import temp root unavailable',
      503,
    );
  }

  await mkdir(tempRootBase, { recursive: true });
  const importId = randomUUID();
  const tempRoot = join(tempRootBase, importId);
  await mkdir(tempRoot, { recursive: true });

  const zipPath = join(tempRoot, '.upload.zip');
  try {
    await streamToFileWithLimit(stream, zipPath, SKILL_LIMITS.ZIP_MAX_BYTES);

    const zipBytes = await readFile(zipPath);
    if (zipBytes.byteLength > SKILL_LIMITS.ZIP_MAX_BYTES) {
      throw new SkillPackageError('ZIP_TOO_LARGE', `ZIP exceeds ${SKILL_LIMITS.ZIP_MAX_BYTES} bytes`, 413);
    }

    const reader = new ZipReader(new BlobReader(new Blob([zipBytes])), {
      checkSignature: true,
    });

    let entries: Entry[];
    try {
      entries = await reader.getEntries();
    } catch (err) {
      throw new SkillPackageError(
        'ZIP_INVALID',
        err instanceof Error ? err.message : 'Invalid zip archive',
      );
    }

    // Count only non-directory entries against MAX_FILES (spec: files, not zip dir nodes).
    let declaredTotal = 0;
    const fileEntries: Entry[] = [];
    for (const entry of entries) {
      assertZipEntryAllowed(entry);
      if (entry.directory) continue;
      // Path checks before any extract.
      normalizeSkillPath(entry.filename.replace(/\/+$/, ''));
      declaredTotal += Math.max(0, entry.uncompressedSize || 0);
      if (declaredTotal > SKILL_LIMITS.VERSION_TOTAL_MAX_BYTES) {
        throw new SkillPackageError('ZIP_EXPAND_TOO_LARGE', 'Zip declared uncompressed size exceeds version budget');
      }
      assertWithinFileLimit(entry.uncompressedSize || 0, entry.filename);
      fileEntries.push(entry);
    }

    assertWithinFileCount(fileEntries.length);

    const files: SkillPackageFile[] = [];
    let actualTotal = 0;
    for (const entry of fileEntries) {
      const remaining = SKILL_LIMITS.VERSION_TOTAL_MAX_BYTES - actualTotal;
      const bytes = await readEntryBytes(entry, remaining);
      actualTotal += bytes.byteLength;
      assertWithinVersionTotal(actualTotal);
      assertWithinFileLimit(bytes.byteLength, entry.filename);
      const path = normalizeSkillPath(entry.filename.replace(/\/+$/, ''));
      files.push({ path, bytes });

      // Materialize under temp root (no escape).
      const target = resolve(tempRoot, path);
      if (target !== tempRoot && !target.startsWith(tempRoot + '/')) {
        throw new SkillPackageError('PATH_INVALID', 'Zip entry escapes import temp root');
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }

    await reader.close();

    async function* iterate(): AsyncIterable<SkillPackageFile> {
      for (const file of files) yield file;
    }

    const pkg = await parseSkillPackage(iterate());
    await rm(zipPath, { force: true }).catch(() => undefined);
    // Persist the unwrapped canonical layout for later commit (TTL managed by service).
    await materializePackageLayout(tempRoot, pkg);
    const expiresAt = new Date(Date.now() + getSkillsImportTtlMs());

    return {
      importId,
      tempRoot,
      expiresAt,
      package: pkg,
      warnings: pkg.warnings,
    };
  } catch (err) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    if (err instanceof SkillPackageError) throw err;
    const message = err instanceof Error ? err.message : 'Invalid zip archive';
    if (/crc|signature|zip/i.test(message)) {
      throw new SkillPackageError('ZIP_INVALID', message);
    }
    throw err;
  }
}

/** Test helper: create an isolated import temp root directory. */
export async function createEphemeralImportTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'skills-import-'));
}
