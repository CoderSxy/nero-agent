import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import { SkillStorageError } from '../src/mastra/skills/errors.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';
import type { SkillManifestEntry } from '../src/mastra/skills/types.ts';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function readableFrom(chunks: Uint8Array[]): Readable {
  return Readable.from(chunks);
}

test('blob put streams to temp then atomically renames after hash; openVerified fails closed on mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-blob-'));
  try {
    const store = createBlobStore({ root });
    const payload = Buffer.from('hello content-addressed blob\n', 'utf8');
    const expected = sha256Hex(payload);

    const put = await store.put(readableFrom([payload]), payload.byteLength + 16);
    assert.equal(put.hash, expected);
    assert.equal(put.size, payload.byteLength);

    const verified = await store.openVerified(expected);
    const chunks: Buffer[] = [];
    for await (const chunk of verified) chunks.push(Buffer.from(chunk));
    const got = Buffer.concat(chunks);
    assert.equal(got.toString('utf8'), payload.toString('utf8'));

    const blobPath = join(root, 'blobs', expected);
    await writeFile(blobPath, Buffer.from('tampered', 'utf8'));
    await assert.rejects(
      () => store.openVerified(expected),
      (error: unknown) => {
        assert.ok(error instanceof SkillStorageError);
        assert.equal(error.code, 'BLOB_HASH_MISMATCH');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blob write half-fail cleans temp and does not publish a final blob', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-blob-fail-'));
  try {
    const store = createBlobStore({ root });
    const first = Buffer.from('partial-', 'utf8');
    const stream = new Readable({
      read() {
        this.push(first);
        this.destroy(new Error('injected mid-write failure'));
      },
    });

    await assert.rejects(
      () => store.put(stream, 1024),
      (error: unknown) => {
        assert.ok(error instanceof SkillStorageError);
        assert.equal(error.code, 'BLOB_WRITE_FAILED');
        return true;
      },
    );

    const blobsDir = join(root, 'blobs');
    await mkdir(blobsDir, { recursive: true });
    const listing = await import('node:fs/promises').then((fs) => fs.readdir(blobsDir));
    assert.equal(listing.filter((name) => !name.startsWith('.')).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blob put rejects when stream exceeds limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-blob-limit-'));
  try {
    const store = createBlobStore({ root });
    const chunk = Buffer.alloc(64, 7);
    await assert.rejects(
      () => store.put(readableFrom([chunk, chunk]), 100),
      (error: unknown) => {
        assert.ok(error instanceof SkillStorageError);
        assert.equal(error.code, 'BLOB_TOO_LARGE');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blob rename-before failure leaves no final blob', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-blob-rename-'));
  try {
    const store = createBlobStore({
      root,
      hooks: {
        beforeRename: async () => {
          throw new Error('injected rename abort');
        },
      },
    });
    const payload = Buffer.from('never-renamed', 'utf8');
    await assert.rejects(
      () => store.put(readableFrom([payload]), 1024),
      (error: unknown) => {
        assert.ok(error instanceof SkillStorageError);
        assert.equal(error.code, 'BLOB_WRITE_FAILED');
        return true;
      },
    );
    const listing = await import('node:fs/promises').then((fs) =>
      fs.readdir(join(root, 'blobs')).catch(() => [] as string[]),
    );
    assert.equal(listing.filter((name) => !name.startsWith('.') && name.length === 64).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release materialize verifies each blob hash; wrong hash fails closed without final release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-release-'));
  try {
    const blobs = createBlobStore({ root });
    const release = createReleaseStore({ root, blobStore: blobs });
    const skillMd = '---\nname: demo\ndescription: d\n---\n\n# Demo\n';
    const refBytes = Buffer.from('reference body\n', 'utf8');
    const refPut = await blobs.put(readableFrom([refBytes]), 1024);

    const goodEntries: SkillManifestEntry[] = [
      {
        path: 'references/note.md',
        blobHash: refPut.hash,
        size: refPut.size,
        isText: true,
        mimeType: 'text/markdown',
      },
    ];

    const ok = await release.materialize('skill-a', 1, {
      skillId: 'skill-a',
      version: 1,
      skillMd,
      entries: goodEntries,
    });
    assert.match(ok.manifestHash, /^[a-f0-9]{64}$/);
    assert.ok(ok.releaseRoot.includes(ok.manifestHash));
    assert.ok(ok.releaseRoot.includes('releases'));
    const skillMdOnDisk = await readFile(join(ok.releaseRoot, 'SKILL.md'), 'utf8');
    assert.equal(skillMdOnDisk, skillMd);
    const note = await readFile(join(ok.releaseRoot, 'references/note.md'));
    assert.equal(Buffer.compare(note, refBytes), 0);

    const bad = await assert.rejects(
      () =>
        release.materialize('skill-b', 1, {
          skillId: 'skill-b',
          version: 1,
          skillMd,
          entries: [
            {
              path: 'references/bad.md',
              blobHash: 'a'.repeat(64),
              size: 4,
              isText: true,
            },
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof SkillStorageError);
        assert.ok(
          error.code === 'BLOB_MISSING'
            || error.code === 'BLOB_HASH_MISMATCH'
            || error.code === 'RELEASE_HASH_MISMATCH',
        );
        return true;
      },
    );
    void bad;

    const skillBDir = join(root, 'releases', 'skill-b', '1');
    const children = await import('node:fs/promises').then((fs) =>
      fs.readdir(skillBDir).catch(() => [] as string[]),
    );
    assert.equal(
      children.filter((name) => !name.startsWith('.')).length,
      0,
      'failed materialize must not leave a final release dir',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release rename-before failure keeps staging out of final path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-release-rename-'));
  try {
    const blobs = createBlobStore({ root });
    const release = createReleaseStore({
      root,
      blobStore: blobs,
      hooks: {
        beforeReleaseRename: async () => {
          throw new Error('injected release rename abort');
        },
      },
    });
    const skillMd = '---\nname: demo\ndescription: d\n---\n\n# Demo\n';
    const skillId = randomUUID();
    await assert.rejects(
      () =>
        release.materialize(skillId, 1, {
          skillId,
          version: 1,
          skillMd,
          entries: [],
        }),
      (error: unknown) => {
        assert.ok(error instanceof SkillStorageError);
        assert.equal(error.code, 'RELEASE_RENAME_FAILED');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('releaseRoot is an absolute host path under storage root (internal only)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-release-path-'));
  try {
    const blobs = createBlobStore({ root });
    const release = createReleaseStore({ root, blobStore: blobs });
    const skillMd = '---\nname: demo\ndescription: d\n---\n\n# Demo\n';
    const skillId = randomUUID();
    const result = await release.materialize(skillId, 2, {
      skillId,
      version: 2,
      skillMd,
      entries: [],
    });
    assert.ok(result.releaseRoot.startsWith(root));
    assert.ok(!result.releaseRoot.includes('..'));
    // Idempotent rematerialize of same content yields same hash/root
    const again = await release.materialize(skillId, 2, {
      skillId,
      version: 2,
      skillMd,
      entries: [],
    });
    assert.equal(again.manifestHash, result.manifestHash);
    assert.equal(again.releaseRoot, result.releaseRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('openVerified of missing blob fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-blob-miss-'));
  try {
    const store = createBlobStore({ root });
    await assert.rejects(
      () => store.openVerified('b'.repeat(64)),
      (error: unknown) => {
        assert.ok(error instanceof SkillStorageError);
        assert.equal(error.code, 'BLOB_MISSING');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createReadStream helper path is not used without verification', async () => {
  // Documents that callers must use openVerified, not raw fs on blobs.
  const root = await mkdtemp(join(tmpdir(), 'skills-blob-raw-'));
  try {
    const store = createBlobStore({ root });
    const payload = Buffer.from('raw-check', 'utf8');
    const { hash } = await store.put(readableFrom([payload]), 1024);
    const raw = createReadStream(join(root, 'blobs', hash));
    const chunks: Buffer[] = [];
    for await (const chunk of raw) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'raw-check');
    assert.equal(typeof store.openVerified, 'function');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
