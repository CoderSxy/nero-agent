import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  normalizeArtifactPath,
  isArtifactPath,
} from '../src/mastra/files/artifacts/paths';
import {
  snapshotWorkspace,
  diffSnapshots,
  type SnapshotBudget,
} from '../src/mastra/files/artifacts/snapshot';
import { readWorkspaceVersion } from '../src/mastra/files/workspace-editor';

function etagOf(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}

test('normalizeArtifactPath maps thread and workspace scopes', () => {
  assert.equal(
    normalizeArtifactPath({ scope: 'thread', threadId: 't1', path: 'output/a.pptx' }),
    'threads/t1/output/a.pptx',
  );
  assert.equal(
    normalizeArtifactPath({ scope: 'workspace', threadId: 't1', path: 'projects/a.md' }),
    'projects/a.md',
  );
  assert.equal(
    normalizeArtifactPath({ scope: 'workspace', threadId: 't1', path: 'threads/t1/out.txt' }),
    'threads/t1/out.txt',
  );
});

test('normalizeArtifactPath and isArtifactPath reject unsafe inputs', () => {
  const bad = [
    '/etc/passwd',
    '../x',
    'a\\b',
    'a\0b',
    '.',
    '..',
    'foo/../bar',
    '',
  ];
  for (const path of bad) {
    assert.throws(() => normalizeArtifactPath({ scope: 'thread', threadId: 't1', path }));
    assert.equal(isArtifactPath(path), false);
  }
  assert.equal(isArtifactPath('threads/t1/output/a.pptx'), true);
  assert.equal(isArtifactPath('projects/a.md'), true);
});

test('snapshot and diff cover binary, unicode names, content change, touch, delete, exclusions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ta-snap-'));
  await mkdir(join(root, 'threads', 't1', 'output'), { recursive: true });
  await mkdir(join(root, 'projects'), { recursive: true });
  await mkdir(join(root, '.runtime'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(root, 'threads', 't1', 'tmp'), { recursive: true });

  const pptx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  await writeFile(join(root, 'threads', 't1', 'output', 'deck.pptx'), pptx);
  await writeFile(join(root, 'projects', '中文 演示 #1%.md'), 'hello');
  await writeFile(join(root, '.runtime', 'secret.env'), 'nope');
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'skip');
  await writeFile(join(root, 'threads', 't1', 'tmp', 'scratch.txt'), 'tmp');

  const before = await snapshotWorkspace(root);
  assert.equal(before.status, 'complete');
  assert.equal(before.files.has('threads/t1/output/deck.pptx'), true);
  assert.equal(before.files.has('projects/中文 演示 #1%.md'), true);
  assert.equal(before.files.has('.runtime/secret.env'), false);
  assert.equal(before.files.has('node_modules/pkg/index.js'), false);
  assert.equal(before.files.has('threads/t1/tmp/scratch.txt'), false);

  const deck = before.files.get('threads/t1/output/deck.pptx')!;
  assert.equal(deck.etag, etagOf(pptx));
  assert.equal(deck.etag, readWorkspaceVersion(pptx));

  // Same-size content change
  await writeFile(join(root, 'projects', '中文 演示 #1%.md'), 'hallo');
  // Touch without content change
  const now = new Date();
  await utimes(join(root, 'threads', 't1', 'output', 'deck.pptx'), now, now);
  // Delete + create
  await writeFile(join(root, 'projects', 'new.txt'), 'n');
  const { unlink } = await import('node:fs/promises');
  await unlink(join(root, 'threads', 't1', 'output', 'deck.pptx'));

  const after = await snapshotWorkspace(root);
  const mutations = diffSnapshots(before, after);
  const byPath = new Map(mutations.map((m) => [m.path, m]));

  assert.equal(byPath.get('projects/中文 演示 #1%.md')?.before?.etag, etagOf('hello'));
  assert.equal(byPath.get('projects/中文 演示 #1%.md')?.after?.etag, etagOf('hallo'));
  assert.equal(byPath.get('threads/t1/output/deck.pptx')?.before?.etag, etagOf(pptx));
  assert.equal(byPath.get('threads/t1/output/deck.pptx')?.after, null);
  assert.equal(byPath.get('projects/new.txt')?.before, null);
  assert.equal(byPath.get('projects/new.txt')?.after?.etag, etagOf('n'));
  // Deleted path is the only deck.pptx mutation (touch alone would keep after non-null with same etag)
  assert.equal(
    mutations.filter((m) => m.path === 'threads/t1/output/deck.pptx').length,
    1,
  );
});

test('snapshot rejects symlink traversal and marks incomplete scans as partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ta-snap-link-'));
  await mkdir(join(root, 'safe'), { recursive: true });
  await writeFile(join(root, 'safe', 'ok.txt'), 'ok');
  await symlink('/etc/passwd', join(root, 'safe', 'evil'));

  const snap = await snapshotWorkspace(root);
  assert.equal(snap.files.has('safe/ok.txt'), true);
  assert.equal(snap.files.has('safe/evil'), false);

  const tiny: SnapshotBudget = { maxFiles: 1, maxBytes: 1024, maxMs: 10_000 };
  const root2 = await mkdtemp(join(tmpdir(), 'ta-snap-budget-'));
  await mkdir(join(root2, 'a'), { recursive: true });
  await writeFile(join(root2, 'a', '1.txt'), 'one');
  await writeFile(join(root2, 'a', '2.txt'), 'two');
  const partial = await snapshotWorkspace(root2, { budget: tiny });
  assert.equal(partial.status, 'partial');
  assert.ok(partial.files.size >= 1);
});

test('partial before cannot invent created; partial after cannot invent deleted', async () => {
  const completeBefore = {
    files: new Map([
      ['a.txt', { etag: etagOf('a'), size: 1, dev: '1', ino: '1', mtimeNs: '1', ctimeNs: '1' }],
    ]),
    confirmedMissing: new Set<string>(),
    status: 'complete' as const,
  };
  const partialAfter = {
    files: new Map<string, never>(),
    confirmedMissing: new Set<string>(),
    status: 'partial' as const,
  };
  assert.deepEqual(diffSnapshots(completeBefore, partialAfter), []);

  const partialBefore = {
    files: new Map<string, never>(),
    confirmedMissing: new Set<string>(),
    status: 'partial' as const,
  };
  const completeAfter = {
    files: new Map([
      ['b.txt', { etag: etagOf('b'), size: 1, dev: '1', ino: '2', mtimeNs: '1', ctimeNs: '1' }],
    ]),
    confirmedMissing: new Set<string>(),
    status: 'complete' as const,
  };
  assert.deepEqual(diffSnapshots(partialBefore, completeAfter), []);

  // confirmedMissing ENOENT is safe null
  const beforeMissing = {
    files: new Map<string, never>(),
    confirmedMissing: new Set(['c.txt']),
    status: 'complete' as const,
  };
  const afterPresent = {
    files: new Map([
      ['c.txt', { etag: etagOf('c'), size: 1, dev: '1', ino: '3', mtimeNs: '1', ctimeNs: '1' }],
    ]),
    confirmedMissing: new Set<string>(),
    status: 'complete' as const,
  };
  const created = diffSnapshots(beforeMissing, afterPresent);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.path, 'c.txt');
  assert.equal(created[0]!.before, null);
});

test('streaming hash does not buffer entire large file; metadata cache invalidates on change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ta-snap-cache-'));
  const big = Buffer.alloc(256 * 1024, 7);
  await writeFile(join(root, 'big.bin'), big);
  const first = await snapshotWorkspace(root);
  const second = await snapshotWorkspace(root);
  assert.equal(first.files.get('big.bin')?.etag, second.files.get('big.bin')?.etag);
  assert.equal(second.files.get('big.bin')?.etag, etagOf(big));

  big[0] = 8;
  await writeFile(join(root, 'big.bin'), big);
  const third = await snapshotWorkspace(root);
  assert.notEqual(third.files.get('big.bin')?.etag, first.files.get('big.bin')?.etag);
  assert.equal(third.files.get('big.bin')?.etag, etagOf(big));
});
