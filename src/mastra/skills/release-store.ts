import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { BlobStore } from './blob-store';
import { SkillStorageError } from './errors';
import type { SkillManifestEntry, SkillReleaseManifest } from './types';
import { isSha256Hex, normalizeSkillPath } from './validation';

export type ReleaseMaterializeResult = {
  manifestHash: string;
  /** Absolute host path — INTERNAL ONLY; never put on HTTP DTOs. */
  releaseRoot: string;
};

export type ReleaseStoreHooks = {
  beforeReleaseRename?: (stagingRoot: string, finalRoot: string) => Promise<void>;
};

export type ReleaseStoreOptions = {
  root: string;
  blobStore: BlobStore;
  hooks?: ReleaseStoreHooks;
};

export type ReleaseStore = {
  materialize: (
    skillId: string,
    version: number,
    manifest: SkillReleaseManifest,
  ) => Promise<ReleaseMaterializeResult>;
  resolveReleaseRoot: (skillId: string, version: number, manifestHash: string) => string;
  verifyRelease: (skillId: string, version: number, manifestHash: string) => Promise<void>;
  computeManifestHash: (skillMd: string, entries: SkillManifestEntry[]) => string;
};

function hashSkillMd(skillMd: string): { blobHash: string; size: number } {
  const buf = Buffer.from(skillMd, 'utf8');
  return {
    blobHash: createHash('sha256').update(buf).digest('hex'),
    size: buf.byteLength,
  };
}

function canonicalManifestLines(skillMd: string, entries: SkillManifestEntry[]): string[] {
  const skill = hashSkillMd(skillMd);
  const all: Array<{ path: string; blobHash: string; size: number }> = [
    { path: 'SKILL.md', blobHash: skill.blobHash, size: skill.size },
    ...entries.map((e) => ({
      path: normalizeSkillPath(e.path),
      blobHash: e.blobHash,
      size: e.size,
    })),
  ];
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return all.map((e) => `${e.path}\0${e.blobHash}\0${e.size}`);
}

export function computeManifestHash(skillMd: string, entries: SkillManifestEntry[]): string {
  const lines = canonicalManifestLines(skillMd, entries);
  const hasher = createHash('sha256');
  for (const line of lines) {
    hasher.update(line);
    hasher.update('\n');
  }
  return hasher.digest('hex');
}

async function copyVerifiedBlobToFile(
  blobStore: BlobStore,
  blobHash: string,
  destPath: string,
  expectedSize: number,
): Promise<void> {
  if (!isSha256Hex(blobHash)) {
    throw new SkillStorageError('INVALID_HASH', `Invalid blob hash for release file`, 400);
  }
  const verified = await blobStore.openVerified(blobHash);
  await mkdir(dirname(destPath), { recursive: true });
  const hasher = createHash('sha256');
  let size = 0;
  const out = createWriteStream(destPath, { flags: 'wx' });
  try {
    await pipeline(
      verified,
      async function* (source) {
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          size += buf.byteLength;
          hasher.update(buf);
          yield buf;
        }
      },
      out,
    );
  } catch (error) {
    await rm(destPath, { force: true }).catch(() => undefined);
    if (error instanceof SkillStorageError) throw error;
    throw new SkillStorageError(
      'RELEASE_HASH_MISMATCH',
      error instanceof Error ? error.message : 'Failed to materialize release file',
    );
  }
  const actual = hasher.digest('hex');
  if (actual !== blobHash || size !== expectedSize) {
    await rm(destPath, { force: true }).catch(() => undefined);
    throw new SkillStorageError(
      'RELEASE_HASH_MISMATCH',
      `Release file hash/size mismatch for ${blobHash}`,
      503,
    );
  }
}

export function createReleaseStore(options: ReleaseStoreOptions): ReleaseStore {
  const { root, blobStore, hooks } = options;

  function resolveReleaseRoot(skillId: string, version: number, manifestHash: string): string {
    if (!isSha256Hex(manifestHash)) {
      throw new SkillStorageError('INVALID_HASH', 'manifestHash must be sha256 hex', 400);
    }
    return join(root, 'releases', skillId, String(version), manifestHash);
  }

  return {
    resolveReleaseRoot,
    computeManifestHash,

    async materialize(skillId, version, manifest) {
      if (manifest.skillId !== skillId || manifest.version !== version) {
        throw new SkillStorageError('RELEASE_INCOMPLETE', 'Manifest skillId/version mismatch', 400);
      }

      const seen = new Set<string>();
      for (const entry of manifest.entries) {
        const path = normalizeSkillPath(entry.path);
        if (path === 'SKILL.md') {
          throw new SkillStorageError(
            'RELEASE_INCOMPLETE',
            'SKILL.md must not appear in resource entries',
            400,
          );
        }
        if (seen.has(path)) {
          throw new SkillStorageError('RELEASE_INCOMPLETE', `Duplicate path: ${path}`, 400);
        }
        seen.add(path);
        if (!isSha256Hex(entry.blobHash)) {
          throw new SkillStorageError('INVALID_HASH', `Invalid blob hash for ${path}`, 400);
        }
      }

      const manifestHash = computeManifestHash(manifest.skillMd, manifest.entries);
      const finalRoot = resolveReleaseRoot(skillId, version, manifestHash);

      try {
        await access(join(finalRoot, 'SKILL.md'));
        await verifyReleaseAt(finalRoot, manifest.skillMd, manifest.entries, manifestHash);
        return { manifestHash, releaseRoot: finalRoot };
      } catch (error) {
        if (error instanceof SkillStorageError && error.code === 'RELEASE_HASH_MISMATCH') {
          throw error;
        }
        // Missing or incomplete — rebuild via staging
      }

      const versionDir = join(root, 'releases', skillId, String(version));
      await mkdir(versionDir, { recursive: true });
      const stagingRoot = join(versionDir, `.staging-${randomUUID()}`);

      try {
        await mkdir(stagingRoot, { recursive: true });
        await writeFile(join(stagingRoot, 'SKILL.md'), manifest.skillMd, { flag: 'wx' });

        for (const entry of manifest.entries) {
          const path = normalizeSkillPath(entry.path);
          await copyVerifiedBlobToFile(
            blobStore,
            entry.blobHash,
            join(stagingRoot, path),
            entry.size,
          );
        }

        // Recompute on staged tree
        await verifyReleaseAt(stagingRoot, manifest.skillMd, manifest.entries, manifestHash);

        if (hooks?.beforeReleaseRename) {
          try {
            await hooks.beforeReleaseRename(stagingRoot, finalRoot);
          } catch (error) {
            throw new SkillStorageError(
              'RELEASE_RENAME_FAILED',
              error instanceof Error ? error.message : 'Release rename aborted',
            );
          }
        }

        try {
          await access(join(finalRoot, 'SKILL.md'));
          await rm(stagingRoot, { recursive: true, force: true });
          return { manifestHash, releaseRoot: finalRoot };
        } catch {
          // final absent
        }

        try {
          await rename(stagingRoot, finalRoot);
        } catch (error) {
          throw new SkillStorageError(
            'RELEASE_RENAME_FAILED',
            error instanceof Error ? error.message : 'Release rename failed',
          );
        }

        return { manifestHash, releaseRoot: finalRoot };
      } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        if (error instanceof SkillStorageError) throw error;
        throw new SkillStorageError(
          'RELEASE_INCOMPLETE',
          error instanceof Error ? error.message : 'Release materialize failed',
        );
      }
    },

    async verifyRelease(skillId, version, manifestHash) {
      const releaseRoot = resolveReleaseRoot(skillId, version, manifestHash);
      let skillMd: string;
      try {
        skillMd = await readFile(join(releaseRoot, 'SKILL.md'), 'utf8');
      } catch {
        throw new SkillStorageError('RELEASE_INCOMPLETE', 'Release SKILL.md missing', 503);
      }
      const skillHash = hashSkillMd(skillMd);
      // Without DB entries we only verify SKILL.md content hash contributes to manifestHash
      // Callers with full entry lists should use materialize rematerialize path.
      // For corrupt SKILL.md detection: recompute with empty entries won't match unless empty.
      // Better: hash entire tree via stored manifest sidecar? Spec uses DB entries.
      // verifyRelease used after corrupt: compare skillMd file hash against what manifest implies.
      // We store no sidecar; verify by re-hashing SKILL.md and checking it is part of expected hash
      // when entries are unknown — insufficient. Require reading all files under release and
      // reconstructing from disk paths.
      const entries = await listReleaseEntries(releaseRoot, blobStore);
      const actual = computeManifestHash(skillMd, entries);
      if (actual !== manifestHash) {
        throw new SkillStorageError(
          'RELEASE_HASH_MISMATCH',
          `Release manifest hash mismatch for ${skillId}@${version}`,
          503,
        );
      }
      // Also verify each file content hash
      for (const entry of entries) {
        const bytes = await readFile(join(releaseRoot, entry.path));
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (digest !== entry.blobHash || bytes.byteLength !== entry.size) {
          throw new SkillStorageError(
            'RELEASE_HASH_MISMATCH',
            `Release file corrupted: ${entry.path}`,
            503,
          );
        }
      }
      void skillHash;
    },
  };
}

async function verifyReleaseAt(
  releaseRoot: string,
  skillMd: string,
  entries: SkillManifestEntry[],
  expectedManifestHash: string,
): Promise<void> {
  const onDisk = await readFile(join(releaseRoot, 'SKILL.md'), 'utf8');
  if (onDisk !== skillMd) {
    throw new SkillStorageError('RELEASE_HASH_MISMATCH', 'Staged SKILL.md mismatch', 503);
  }
  const actual = computeManifestHash(skillMd, entries);
  if (actual !== expectedManifestHash) {
    throw new SkillStorageError('RELEASE_HASH_MISMATCH', 'Manifest hash mismatch', 503);
  }
  for (const entry of entries) {
    const path = normalizeSkillPath(entry.path);
    const bytes = await readFile(join(releaseRoot, path));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.blobHash || bytes.byteLength !== entry.size) {
      throw new SkillStorageError(
        'RELEASE_HASH_MISMATCH',
        `Release file hash mismatch: ${path}`,
        503,
      );
    }
  }
}

async function listReleaseEntries(
  releaseRoot: string,
  _blobStore: BlobStore,
): Promise<SkillManifestEntry[]> {
  const { readdir } = await import('node:fs/promises');
  const entries: SkillManifestEntry[] = [];

  async function walk(rel: string): Promise<void> {
    const abs = rel ? join(releaseRoot, rel) : releaseRoot;
    const items = await readdir(abs, { withFileTypes: true });
    for (const item of items) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        await walk(childRel);
        continue;
      }
      if (!item.isFile()) continue;
      if (childRel === 'SKILL.md') continue;
      const bytes = await readFile(join(releaseRoot, childRel));
      entries.push({
        path: childRel,
        blobHash: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.byteLength,
        isText: false,
      });
    }
  }

  await walk('');
  return entries;
}
