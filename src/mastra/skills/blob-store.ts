import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SkillStorageError } from './errors';
import { isSha256Hex } from './validation';

export type BlobPutResult = {
  hash: string;
  size: number;
};

export type BlobStoreHooks = {
  /** Invoked after temp write + hash, before atomic rename to final blob path. */
  beforeRename?: (tmpPath: string, finalPath: string) => Promise<void>;
};

export type BlobStoreOptions = {
  root: string;
  hooks?: BlobStoreHooks;
};

export type BlobStore = {
  put: (stream: NodeJS.ReadableStream | Readable, limit: number) => Promise<BlobPutResult>;
  openVerified: (hash: string) => Promise<Readable>;
  blobPath: (hash: string) => string;
  exists: (hash: string) => Promise<boolean>;
};

function assertValidHash(hash: string): void {
  if (!isSha256Hex(hash)) {
    throw new SkillStorageError('INVALID_HASH', 'Blob hash must be lowercase sha256 hex', 400);
  }
}

async function ensureBlobsDir(root: string): Promise<string> {
  const blobs = join(root, 'blobs');
  await mkdir(blobs, { recursive: true });
  await mkdir(join(blobs, '.tmp'), { recursive: true });
  return blobs;
}

export function createBlobStore(options: BlobStoreOptions): BlobStore {
  const root = options.root;
  const hooks = options.hooks;

  function blobPath(hash: string): string {
    assertValidHash(hash);
    return join(root, 'blobs', hash);
  }

  return {
    blobPath,

    async exists(hash) {
      assertValidHash(hash);
      try {
        await access(blobPath(hash));
        return true;
      } catch {
        return false;
      }
    },

    async put(stream, limit) {
      if (!Number.isFinite(limit) || limit < 0) {
        throw new SkillStorageError('BLOB_TOO_LARGE', 'Invalid blob size limit', 400);
      }
      const blobsDir = await ensureBlobsDir(root);
      const tmpPath = join(blobsDir, '.tmp', `${randomUUID()}.part`);
      const hasher = createHash('sha256');
      let size = 0;

      const input = Readable.from(stream as AsyncIterable<Uint8Array | Buffer | string>);
      const counting = new Transform({
        transform(chunk, _enc, callback) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          size += buf.byteLength;
          if (size > limit) {
            callback(
              new SkillStorageError('BLOB_TOO_LARGE', `Blob exceeds limit of ${limit} bytes`, 413),
            );
            return;
          }
          hasher.update(buf);
          callback(null, buf);
        },
      });

      try {
        await pipeline(input, counting, createWriteStream(tmpPath, { flags: 'wx' }));
        const digest = hasher.digest('hex');
        const finalPath = join(blobsDir, digest);

        if (hooks?.beforeRename) {
          try {
            await hooks.beforeRename(tmpPath, finalPath);
          } catch (error) {
            throw new SkillStorageError(
              'BLOB_WRITE_FAILED',
              error instanceof Error ? error.message : 'Blob rename aborted',
            );
          }
        }

        try {
          await access(finalPath);
          await rm(tmpPath, { force: true });
          return { hash: digest, size };
        } catch {
          // final not present yet
        }

        try {
          await rename(tmpPath, finalPath);
        } catch (error) {
          throw new SkillStorageError(
            'BLOB_WRITE_FAILED',
            error instanceof Error ? error.message : 'Blob rename failed',
          );
        }

        return { hash: digest, size };
      } catch (error) {
        await rm(tmpPath, { force: true }).catch(() => undefined);
        if (error instanceof SkillStorageError) throw error;
        throw new SkillStorageError(
          'BLOB_WRITE_FAILED',
          error instanceof Error ? error.message : 'Blob write failed',
        );
      }
    },

    async openVerified(hash) {
      assertValidHash(hash);
      const path = blobPath(hash);
      let fileStat;
      try {
        fileStat = await stat(path);
      } catch {
        throw new SkillStorageError('BLOB_MISSING', `Blob not found: ${hash}`, 404);
      }
      if (!fileStat.isFile()) {
        throw new SkillStorageError('BLOB_MISSING', `Blob not found: ${hash}`, 404);
      }

      const hasher = createHash('sha256');
      const source = createReadStream(path);
      try {
        for await (const chunk of source) {
          hasher.update(chunk);
        }
      } catch (error) {
        throw new SkillStorageError(
          'BLOB_HASH_MISMATCH',
          error instanceof Error ? error.message : 'Blob verification failed',
        );
      }

      const actual = hasher.digest('hex');
      if (actual !== hash) {
        throw new SkillStorageError('BLOB_HASH_MISMATCH', `Blob hash mismatch for ${hash}`, 503);
      }

      try {
        await access(path);
      } catch {
        throw new SkillStorageError('BLOB_MISSING', `Blob disappeared after verify: ${hash}`, 404);
      }
      return createReadStream(path);
    },
  };
}
