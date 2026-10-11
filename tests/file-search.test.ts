import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import {
  assertGlobPattern,
  GlobPatternError,
  globFiles,
  grepFiles,
  readFileCapped,
} from '../src/mastra/files/file-search';
import { ensureThreadDirectory, ensureUserWorkspace } from '../src/mastra/workspace/manager';

const USER_A = '11111111-1111-4111-8111-111111111111';
const THREAD_A = 'thread-a1';
const THREAD_B = 'thread-b2';

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

function lookup() {
  return {
    getThreadById: async ({ threadId }: { threadId: string }) => {
      if (threadId === THREAD_A || threadId === THREAD_B) {
        return { id: threadId, resourceId: USER_A };
      }
      return null;
    },
  };
}

async function withRoot(run: (workspaceRoot: string) => Promise<void>) {
  const previous = process.env.WORKSPACE_ROOT;
  const root = await mkdtemp(join(tmpdir(), 'file-search-'));
  process.env.WORKSPACE_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previous;
  }
}

async function seedThreadFiles(): Promise<{ root: string }> {
  const auth = authContextFromUser(user(USER_A));
  const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
  await mkdir(join(root, 'nested', 'deep'), { recursive: true });
  await writeFile(join(root, 'a.md'), 'root-md');
  await writeFile(join(root, 'b.txt'), 'root-txt');
  await writeFile(join(root, 'nested', 'c.md'), 'nested-md');
  await writeFile(join(root, 'nested', 'deep', 'd.md'), 'deep-md');
  await writeFile(join(root, '你好 world.md'), 'unicode');
  await mkdir(join(root, 'only-dir'), { recursive: true });
  return { root };
}

test('glob *.md matches only files at the base root', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    const result = await globFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      pattern: '*.md',
    });
    assert.equal(result.truncated, false);
    assert.deepEqual(
      result.entries.map(e => e.path).sort(),
      ['a.md', '你好 world.md'].sort(),
    );
    assert.ok(result.entries.every(e => typeof e.size === 'number' && e.size > 0));
  });
});

test('glob **/*.md matches nested paths and root files', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    const result = await globFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      pattern: '**/*.md',
    });
    assert.deepEqual(
      result.entries.map(e => e.path),
      ['a.md', 'nested/c.md', 'nested/deep/d.md', '你好 world.md'].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
  });
});

test('glob ? matches a single path segment character', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    await writeFile(join(root, 'x.md'), 'x');
    const result = await globFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      pattern: '?.md',
    });
    assert.deepEqual(
      result.entries.map(e => e.path).sort(),
      ['a.md', 'x.md'].sort(),
    );
  });
});

test('glob results are deterministic lexicographic order', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    const first = await globFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      pattern: '**/*',
    });
    const second = await globFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      pattern: '**/*',
    });
    const paths = first.entries.map(e => e.path);
    assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    assert.deepEqual(second.entries, first.entries);
  });
});

test('glob returns only regular files, not directories', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    const result = await globFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      pattern: '**/*',
    });
    assert.ok(!result.entries.some(e => e.path === 'only-dir' || e.path === 'nested'));
    assert.ok(result.entries.some(e => e.path === 'a.md'));
  });
});

test('glob matches relative to basePath and returns scope-root-relative paths', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    const result = await globFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      basePath: 'nested',
      pattern: '*.md',
    });
    assert.deepEqual(result.entries.map(e => e.path), ['nested/c.md']);
    assert.ok(!result.entries.some(e => e.path === 'c.md'));
    assert.ok(!result.entries.some(e => e.path === 'nested/deep/d.md'));
  });
});

test('glob truncates at 200 results with reason', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await mkdir(join(root, 'many'), { recursive: true });
    for (let i = 0; i < 12; i += 1) {
      await writeFile(join(root, 'many', `f${String(i).padStart(3, '0')}.txt`), 'x');
    }
    const result = await globFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      pattern: 'many/*',
      maxResults: 5,
    });
    assert.equal(result.entries.length, 5);
    assert.equal(result.truncated, true);
    assert.match(String(result.reason), /result|5|limit|上限|结果/i);
    assert.match(String(result.reason), /5/);
  });
});

test('glob truncates at visited budget with reason', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    const result = await globFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      pattern: '**/*',
      maxVisited: 3,
    });
    assert.equal(result.truncated, true);
    assert.ok(result.visitedEntries <= 3);
    assert.match(String(result.reason), /visit|3|limit|上限|遍历/i);
    assert.match(String(result.reason), /3/);
  });
});

test('glob truncates at maxOutputBytes with reason', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    const result = await globFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      pattern: '**/*',
      maxOutputBytes: 80,
    });
    assert.equal(result.truncated, true);
    assert.ok(result.entries.length >= 0);
    assert.match(String(result.reason), /output|size|bytes|输出|上限/i);
    assert.match(String(result.reason), /80/);
  });
});

test('glob skips symlink directories and files', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    const outside = await mkdtemp(join(tmpdir(), 'file-search-out-'));
    await writeFile(join(outside, 'secret.md'), 'nope');
    await symlink(outside, join(root, 'link-dir'));
    await symlink(join(outside, 'secret.md'), join(root, 'link.md'));
    const result = await globFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      pattern: '**/*',
    });
    assert.ok(!result.entries.some(e => e.path.includes('secret') || e.path === 'link.md' || e.path === 'link-dir'));
  });
});

test('glob skips foreign thread subtrees in workspace scope', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    await ensureThreadDirectory(auth, THREAD_A, lookup());
    await ensureThreadDirectory(auth, THREAD_B, lookup());
    const workspaceRoot = await ensureUserWorkspace(auth);
    await writeFile(join(workspaceRoot, 'threads', THREAD_A, 'mine.md'), 'mine');
    await writeFile(join(workspaceRoot, 'threads', THREAD_B, 'theirs.md'), 'theirs');
    await mkdir(join(workspaceRoot, 'uploads', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), { recursive: true });
    await writeFile(
      join(workspaceRoot, 'uploads', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'note.txt'),
      'note',
    );
    const result = await globFiles({
      root: workspaceRoot,
      scope: 'workspace',
      threadId: THREAD_A,
      pattern: '**/*',
    });
    const paths = result.entries.map(e => e.path);
    assert.ok(paths.some(p => p === `threads/${THREAD_A}/mine.md`));
    assert.ok(paths.some(p => p.endsWith('note.txt')));
    assert.ok(!paths.some(p => p.includes(THREAD_B)));
  });
});

test('glob abort signal stops traversal', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    const controller = new AbortController();
    controller.abort();
    const result = await globFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      pattern: '**/*',
      signal: controller.signal,
    });
    assert.equal(result.truncated, true);
    assert.match(String(result.reason), /abort|取消|中断/i);
    assert.ok(result.entries.length === 0 || result.visitedEntries >= 0);
  });
});

test('glob rejects unsupported pattern metacharacters', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    for (const pattern of ['*.{md,txt}', 'file[0-9].md', '(a|b).md', 'a+b.md', 'foo\\bar']) {
      await assert.rejects(
        () => globFiles({ root, scope: 'thread', threadId: THREAD_A, pattern }),
        /pattern|模式|invalid|无效/i,
      );
    }
  });
});

test('glob rejects patterns with more than two ** tokens', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    assert.equal(assertGlobPattern('**/a/**/b'), '**/a/**/b');
    await assert.rejects(
      () => globFiles({ root, scope: 'thread', threadId: THREAD_A, pattern: '**/a/**/b/**' }),
      (error: unknown) => error instanceof GlobPatternError && error.code === 'INVALID_PATTERN',
    );
    assert.throws(
      () => assertGlobPattern('**/**/**'),
      (error: unknown) => error instanceof GlobPatternError && error.code === 'INVALID_PATTERN',
    );
  });
});

test('grep matches literal a.b not regex', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'lit.txt'), 'prefix a.b suffix\naxb should not\n');
    const result = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'a.b',
    });
    assert.equal(result.truncated, false);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]!.path, 'lit.txt');
    assert.equal(result.matches[0]!.lineNumber, 1);
    assert.match(result.matches[0]!.line, /a\.b/);
    assert.ok(!result.matches.some(m => m.line.includes('axb')));
  });
});

test('grep caseSensitive defaults true and can be disabled', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'case.txt'), 'Hello\nhello\n');
    const sensitive = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'Hello',
    });
    assert.deepEqual(
      sensitive.matches.map(m => m.lineNumber),
      [1],
    );
    const insensitive = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'Hello',
      caseSensitive: false,
    });
    assert.deepEqual(
      insensitive.matches.map(m => m.lineNumber),
      [1, 2],
    );
  });
});

test('grep finds Chinese and emoji literals', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'zh.txt'), '你好世界\nrocket 🚀 here\n');
    const zh = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: '你好',
    });
    assert.equal(zh.matches.length, 1);
    assert.equal(zh.matches[0]!.lineNumber, 1);
    const emoji = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: '🚀',
    });
    assert.equal(emoji.matches.length, 1);
    assert.equal(emoji.matches[0]!.lineNumber, 2);
  });
});

test('grep counts CRLF lines from 1 and returns one match per line', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'crlf.txt'), 'alpha hit\r\nbeta hit hit\r\ngamma\r\n');
    const result = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'hit',
    });
    assert.deepEqual(
      result.matches.map(m => ({ path: m.path, lineNumber: m.lineNumber })),
      [
        { path: 'crlf.txt', lineNumber: 1 },
        { path: 'crlf.txt', lineNumber: 2 },
      ],
    );
  });
});

test('grep results are stable lexicographic path then line order', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'b.txt'), 'hit\n');
    await writeFile(join(root, 'a.txt'), 'x\nhit\n');
    await writeFile(join(root, 'nested', 'c.txt'), 'hit\n');
    const first = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'hit',
    });
    const second = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'hit',
    });
    assert.deepEqual(
      first.matches.map(m => `${m.path}:${m.lineNumber}`),
      ['a.txt:2', 'b.txt:1', 'nested/c.txt:1'],
    );
    assert.deepEqual(second.matches, first.matches);
  });
});

test('grep etag is quoted SHA-256 of file bytes', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    const content = 'etag line hit\n';
    await writeFile(join(root, 'etag.txt'), content);
    const result = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'hit',
    });
    const expected = `"${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}"`;
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]!.etag, expected);
    assert.match(result.matches[0]!.etag, /^"[0-9a-f]{64}"$/);
  });
});

test('grep skips binary NUL and invalid UTF-8 files', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'ok.txt'), 'findme\n');
    await writeFile(join(root, 'nul.bin'), Buffer.from([0x66, 0x00, 0x69]));
    await writeFile(join(root, 'bad.bin'), Buffer.from([0xff, 0xfe, 0xfd]));
    const result = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'findme',
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]!.path, 'ok.txt');
    assert.ok(result.skippedBinaryFiles >= 2);
  });
});

test('grep skips files larger than 2 MiB', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'small.txt'), 'needle\n');
    await writeFile(join(root, 'huge.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const result = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'needle',
      maxFileBytes: 2 * 1024 * 1024,
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]!.path, 'small.txt');
    assert.ok(result.skippedLargeFiles >= 1);
  });
});

test('readFileCapped never returns more than maxBytes + 1', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    const hostPath = join(root, 'capped.txt');
    await writeFile(hostPath, Buffer.alloc(64 * 1024, 0x62));
    const bytes = await readFileCapped(hostPath, 128);
    assert.equal(bytes.byteLength, 129);
  });
});

test('readFileCapped refuses to follow a symlink (O_NOFOLLOW)', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    const outside = await mkdtemp(join(tmpdir(), 'file-search-secret-'));
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'exfiltrate-me');
    const linkPath = join(root, 'trap.txt');
    await symlink(secret, linkPath);
    await assert.rejects(
      () => readFileCapped(linkPath, 1024),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ELOOP',
    );
  });
});

test('grep post-read size guard skips oversized bytes without matching', async () => {
  // Injected read returns > maxFileBytes while on-disk lstat size stays small (TOCTOU / seam).
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'tiny.txt'), 'needle in hay\n');
    const maxFileBytes = 64;
    const result = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'needle',
      maxFileBytes,
      readFileBytes: async () => Buffer.alloc(maxFileBytes + 1, 0x61),
    });
    assert.equal(result.matches.length, 0);
    assert.ok(result.skippedLargeFiles >= 1);
    assert.equal(result.scannedFiles, 0);
    assert.equal(result.truncated, false);
  });
});

test('grep post-read totalBytes uses actual length for budget stop', async () => {
  // lstat sizes stay under budget; injected larger payloads trip the post-read total guard.
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'a.txt'), 'aa\n');
    await writeFile(join(root, 'b.txt'), 'n\n');
    const result = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'needle',
      maxTotalBytes: 10,
      readFileBytes: async hostPath => {
        if (hostPath.endsWith(`${sep}a.txt`) || hostPath.endsWith('/a.txt')) {
          return Buffer.from('aaaaaaaa');
        }
        return Buffer.from('needle');
      },
    });
    assert.equal(result.truncated, true);
    assert.match(String(result.reason), /byte|MiB|总|上限|10|limit/i);
    assert.equal(result.matches.length, 0);
    assert.equal(result.scannedFiles, 1);
  });
});

test('grep clips output lines at 300 Unicode characters', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    const prefix = '字'.repeat(280);
    const line = `${prefix}HIT${'尾'.repeat(40)}`;
    await writeFile(join(root, 'long.txt'), `${line}\n`);
    const result = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'HIT',
    });
    assert.equal(result.matches.length, 1);
    assert.equal([...result.matches[0]!.line].length, 300);
    assert.equal(result.matches[0]!.lineTruncated, true);
    assert.ok(result.matches[0]!.line.includes('HIT'));
  });
});

test('grep includes a match beyond the first 300 Unicode characters', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'late.txt'), `${'字'.repeat(400)}HIT${'尾'.repeat(40)}\n`);
    const result = await grepFiles({ root, scope: 'thread', threadId: THREAD_A, query: 'HIT' });
    assert.equal(result.matches.length, 1);
    assert.ok(result.matches[0]!.line.includes('HIT'));
    assert.ok([...result.matches[0]!.line].length <= 300);
    assert.equal(result.matches[0]!.lineTruncated, true);
  });
});

test('grep keeps a late case-insensitive match after Unicode case expansion', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'fold.txt'), `${'İ'.repeat(400)}hit${'尾'.repeat(400)}\n`);
    const result = await grepFiles({
      root, scope: 'thread', threadId: THREAD_A, query: 'HIT', caseSensitive: false,
    });
    assert.equal(result.matches.length, 1);
    assert.ok(result.matches[0]!.line.includes('hit'));
  });
});

test('grep rejects query longer than 256 Unicode code points', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'q.txt'), 'x\n');
    const query = '字'.repeat(257);
    assert.equal([...query].length, 257);
    await assert.rejects(
      () => grepFiles({ root, scope: 'thread', threadId: THREAD_A, query }),
      /query|查询|256|长度|invalid|无效/i,
    );
  });
});

test('grep truncates at scanned-file budget with reason', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await mkdir(join(root, 'many'), { recursive: true });
    for (let i = 0; i < 8; i += 1) {
      await writeFile(join(root, 'many', `f${i}.txt`), 'nope\n');
    }
    const result = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'zzz',
      filePattern: 'many/*',
      maxFiles: 3,
    });
    assert.equal(result.matches.length, 0);
    assert.equal(result.truncated, true);
    assert.ok(result.scannedFiles <= 3);
    assert.match(String(result.reason), /file|扫描|上限|3|limit/i);
  });
});

test('grep truncates at total-bytes budget with reason', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'a.txt'), 'a'.repeat(40) + '\n');
    await writeFile(join(root, 'b.txt'), 'b'.repeat(40) + '\n');
    await writeFile(join(root, 'c.txt'), 'needle\n');
    const result = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'needle',
      maxTotalBytes: 50,
    });
    assert.equal(result.truncated, true);
    assert.match(String(result.reason), /byte|MiB|总|上限|50|limit/i);
  });
});

test('grep truncates at 100-match and 32 KiB output budgets', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    const lines = Array.from({ length: 20 }, (_, i) => `hit line ${i}`).join('\n') + '\n';
    await writeFile(join(root, 'hits.txt'), lines);
    const matchBudget = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'hit',
      maxMatches: 5,
    });
    assert.equal(matchBudget.matches.length, 5);
    assert.equal(matchBudget.truncated, true);
    assert.match(String(matchBudget.reason), /match|命中|结果|5|上限|limit/i);

    const outputBudget = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'hit',
      maxOutputBytes: 120,
    });
    assert.equal(outputBudget.truncated, true);
    assert.ok(outputBudget.matches.length >= 0);
    assert.match(String(outputBudget.reason), /output|bytes|输出|上限|120/i);
  });
});

test('grep truncates at visited budget and abort', async () => {
  await withRoot(async () => {
    const { root } = await seedThreadFiles();
    await writeFile(join(root, 'a.md'), 'hit in md\n');
    const visited = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'hit',
      maxVisited: 3,
    });
    assert.equal(visited.truncated, true);
    assert.match(String(visited.reason), /visit|遍历|3|上限|limit/i);

    const controller = new AbortController();
    controller.abort();
    const aborted = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'hit',
      signal: controller.signal,
    });
    assert.equal(aborted.truncated, true);
    assert.match(String(aborted.reason), /abort|取消|中断/i);
  });
});

test('grep distinguishes true no-match from truncated no-match', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await writeFile(join(root, 'only.txt'), 'alpha\n');
    const trueMiss = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'missing-token-xyz',
    });
    assert.equal(trueMiss.matches.length, 0);
    assert.equal(trueMiss.truncated, false);
    assert.equal(trueMiss.reason, undefined);

    await mkdir(join(root, 'batch'), { recursive: true });
    for (let i = 0; i < 6; i += 1) {
      await writeFile(join(root, 'batch', `n${i}.txt`), 'nope\n');
    }
    const truncatedMiss = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'missing-token-xyz',
      filePattern: 'batch/*',
      maxFiles: 2,
    });
    assert.equal(truncatedMiss.matches.length, 0);
    assert.equal(truncatedMiss.truncated, true);
    assert.ok(truncatedMiss.reason);
  });
});

test('grep skips symlinks and foreign thread files in workspace scope', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    await ensureThreadDirectory(auth, THREAD_A, lookup());
    await ensureThreadDirectory(auth, THREAD_B, lookup());
    const workspaceRoot = await ensureUserWorkspace(auth);
    await writeFile(join(workspaceRoot, 'threads', THREAD_A, 'mine.txt'), 'secret-hit\n');
    await writeFile(join(workspaceRoot, 'threads', THREAD_B, 'theirs.txt'), 'secret-hit\n');
    const outside = await mkdtemp(join(tmpdir(), 'grep-out-'));
    await writeFile(join(outside, 'linked.txt'), 'secret-hit\n');
    await symlink(join(outside, 'linked.txt'), join(workspaceRoot, 'link.txt'));
    const result = await grepFiles({
      root: workspaceRoot,
      scope: 'workspace',
      threadId: THREAD_A,
      query: 'secret-hit',
    });
    const paths = result.matches.map(m => m.path);
    assert.ok(paths.includes(`threads/${THREAD_A}/mine.txt`));
    assert.ok(!paths.some(p => p.includes(THREAD_B)));
    assert.ok(!paths.includes('link.txt'));
  });
});

test('grep filePattern defaults to **/* and respects basePath', async () => {
  await withRoot(async () => {
    const auth = authContextFromUser(user(USER_A));
    const { hostPath: root } = await ensureThreadDirectory(auth, THREAD_A, lookup());
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'root.txt'), 'findme\n');
    await writeFile(join(root, 'nested', 'child.txt'), 'findme\n');
    await writeFile(join(root, 'nested', 'skip.md'), 'findme\n');
    const all = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'findme',
    });
    assert.deepEqual(
      all.matches.map(m => m.path).sort(),
      ['nested/child.txt', 'nested/skip.md', 'root.txt'].sort(),
    );
    const filtered = await grepFiles({
      root,
      scope: 'thread',
      threadId: THREAD_A,
      query: 'findme',
      basePath: 'nested',
      filePattern: '*.txt',
    });
    assert.deepEqual(
      filtered.matches.map(m => m.path),
      ['nested/child.txt'],
    );
  });
});
