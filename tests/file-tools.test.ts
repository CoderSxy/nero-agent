import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { agent, listAgentToolIds } from '../src/mastra/agents/agent';
import { userFileTools } from '../src/mastra/files/tools';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const THREAD_ID = 'thread-a1';
const UPLOAD_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function toolContext(threadId?: string) {
  const requestContext = new RequestContext();
  requestContext.set('mastra__user', { id: USER_ID, email: 'a@example.test', displayName: 'a', roles: ['user'] });
  return {
    requestContext,
    mastra: { getAgent: () => ({ getMemory: async () => ({
      getThreadById: async ({ threadId: id }: { threadId: string }) =>
        id === THREAD_ID ? { id, resourceId: USER_ID } : null,
    }) }) },
    agent: threadId ? { threadId } : undefined,
  } as never;
}

function regularUserContext() {
  const requestContext = new RequestContext();
  requestContext.set('mastra__user', {
    id: USER_ID,
    email: 'a@example.test',
    displayName: 'a',
    roles: ['user'],
  });
  return requestContext;
}

function schemaAccepts(tool: { inputSchema: unknown }, value: unknown): boolean {
  return (tool.inputSchema as { safeParse(value: unknown): { success: boolean } }).safeParse(value).success;
}

test('read_file accepts path and returns content with quoted SHA-256 etag and byte size', async () => {
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'agent-file-read-'));
  try {
    const content = '你好 UTF-8 文本';
    const input = { path: 'notes/hello.txt', content };
    assert.equal((userFileTools.read_file.inputSchema as { safeParse(value: unknown): { success: boolean } })
      .safeParse({ path: 'notes/hello.txt' }).success, true);
    await userFileTools.write_file.execute!(input as never, toolContext(THREAD_ID));
    const result = await userFileTools.read_file.execute!(
      { path: 'notes/hello.txt' } as never,
      toolContext(THREAD_ID),
    ) as { path: string; name: string; content: string; etag: string; size: number };
    const bytes = Buffer.from(content, 'utf8');
    const expectedEtag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
    assert.equal(result.path, 'notes/hello.txt');
    assert.equal(result.name, 'hello.txt');
    assert.equal(result.content, content);
    assert.equal(result.etag, expectedEtag);
    assert.match(result.etag, /^"[0-9a-f]{64}"$/);
    assert.equal(result.size, bytes.byteLength);
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('file tool writes into the authenticated agent thread without a model-supplied threadId', async () => {
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'agent-file-tool-'));
  try {
    const input = { path: 'reports/result.md', content: '# Saved' };
    assert.equal((userFileTools.write_file.inputSchema as { safeParse(value: unknown): { success: boolean } })
      .safeParse(input).success, true);
    const result = await userFileTools.write_file.execute!(input as never, toolContext(THREAD_ID));
    assert.deepEqual(result, { path: `/user-files/${THREAD_ID}/reports/result.md` });
    assert.equal(await readFile(join(process.env.WORKSPACE_ROOT, 'users', USER_ID, 'workspace',
      'threads', THREAD_ID, 'reports', 'result.md'), 'utf8'), '# Saved');
    const html = { path: 'reports/result.html', content: '<h1>Saved</h1>' };
    await userFileTools.write_file.execute!(html as never, toolContext(THREAD_ID));
    assert.equal(await readFile(join(process.env.WORKSPACE_ROOT, 'users', USER_ID, 'workspace',
      'threads', THREAD_ID, 'reports', 'result.html'), 'utf8'), html.content);
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('file tool rejects execution without a trusted agent thread', async () => {
  await assert.rejects(() => userFileTools.write_file.execute!(
    { path: 'result.html', content: '<h1>test</h1>' } as never, toolContext(),
  ), /thread/i);
});

test('glob tool finds thread files via trusted auth and returns truncation metadata', async () => {
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'agent-file-glob-'));
  try {
    assert.equal(
      (userFileTools.glob.inputSchema as { safeParse(value: unknown): { success: boolean } })
        .safeParse({ pattern: '**/*.md' }).success,
      true,
    );
    await userFileTools.write_file.execute!(
      { path: 'reports/a.md', content: '# A' } as never,
      toolContext(THREAD_ID),
    );
    await userFileTools.write_file.execute!(
      { path: 'reports/b.txt', content: 'B' } as never,
      toolContext(THREAD_ID),
    );
    const result = await userFileTools.glob.execute!(
      { pattern: '**/*.md' } as never,
      toolContext(THREAD_ID),
    ) as {
      entries: Array<{ path: string; size: number }>;
      visitedEntries: number;
      truncated: boolean;
      reason?: string;
    };
    assert.deepEqual(result.entries.map(e => e.path), ['reports/a.md']);
    assert.equal(typeof result.visitedEntries, 'number');
    assert.equal(result.truncated, false);
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('glob tool defaults to thread scope and accepts explicit workspace scope', async () => {
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'agent-file-glob-scope-'));
  try {
    await userFileTools.write_file.execute!(
      { path: 'only-thread.md', content: 't' } as never,
      toolContext(THREAD_ID),
    );
    const threadResult = await userFileTools.glob.execute!(
      { pattern: '**/*.md' } as never,
      toolContext(THREAD_ID),
    ) as { entries: Array<{ path: string }> };
    assert.ok(threadResult.entries.some(e => e.path === 'only-thread.md'));

    const uploadDir = join(
      process.env.WORKSPACE_ROOT!,
      'users',
      USER_ID,
      'workspace',
      'uploads',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, 'note.txt'), 'n');

    const workspaceResult = await userFileTools.glob.execute!(
      { pattern: 'uploads/**/*.txt', scope: 'workspace' } as never,
      toolContext(THREAD_ID),
    ) as { entries: Array<{ path: string }> };
    assert.ok(
      workspaceResult.entries.some(
        e => e.path === 'uploads/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/note.txt',
      ),
    );

    const defaultMiss = await userFileTools.glob.execute!(
      { pattern: 'uploads/**/*.txt' } as never,
      toolContext(THREAD_ID),
    ) as { entries: Array<{ path: string }> };
    assert.equal(defaultMiss.entries.length, 0);
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('grep tool finds literal matches with etag matching read_file', async () => {
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'agent-file-grep-'));
  try {
    assert.equal(
      (userFileTools.grep.inputSchema as { safeParse(value: unknown): { success: boolean } })
        .safeParse({ query: 'a.b' }).success,
      true,
    );
    await userFileTools.write_file.execute!(
      { path: 'reports/a.md', content: 'literal a.b here\naxb no\n' } as never,
      toolContext(THREAD_ID),
    );
    const grepResult = await userFileTools.grep.execute!(
      { query: 'a.b' } as never,
      toolContext(THREAD_ID),
    ) as {
      matches: Array<{ path: string; lineNumber: number; line: string; lineTruncated: boolean; etag: string }>;
      scannedFiles: number;
      skippedBinaryFiles: number;
      skippedLargeFiles: number;
      truncated: boolean;
      reason?: string;
    };
    assert.equal(grepResult.truncated, false);
    assert.equal(grepResult.matches.length, 1);
    assert.equal(grepResult.matches[0]!.path, 'reports/a.md');
    assert.equal(grepResult.matches[0]!.lineNumber, 1);
    assert.match(grepResult.matches[0]!.etag, /^"[0-9a-f]{64}"$/);

    const readResult = await userFileTools.read_file.execute!(
      { path: 'reports/a.md' } as never,
      toolContext(THREAD_ID),
    ) as { etag: string };
    assert.equal(grepResult.matches[0]!.etag, readResult.etag);
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('grep tool defaults to thread scope and searches exact workspace path when requested', async () => {
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'agent-file-grep-scope-'));
  try {
    await userFileTools.write_file.execute!(
      { path: 'thread-only.txt', content: 'scope-hit\n' } as never,
      toolContext(THREAD_ID),
    );
    const threadHit = await userFileTools.grep.execute!(
      { query: 'scope-hit' } as never,
      toolContext(THREAD_ID),
    ) as { matches: Array<{ path: string }> };
    assert.ok(threadHit.matches.some(m => m.path === 'thread-only.txt'));

    const uploadRel = 'uploads/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/note.txt';
    const uploadDir = join(
      process.env.WORKSPACE_ROOT!,
      'users',
      USER_ID,
      'workspace',
      'uploads',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, 'note.txt'), 'upload-hit\n');

    const defaultMiss = await userFileTools.grep.execute!(
      { query: 'upload-hit' } as never,
      toolContext(THREAD_ID),
    ) as { matches: Array<{ path: string }> };
    assert.equal(defaultMiss.matches.length, 0);

    const workspaceHit = await userFileTools.grep.execute!(
      { query: 'upload-hit', scope: 'workspace', basePath: uploadRel.replace(/\/note\.txt$/, '') } as never,
      toolContext(THREAD_ID),
    ) as { matches: Array<{ path: string }> };
    assert.ok(workspaceHit.matches.some(m => m.path === uploadRel));
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('file tool rejects a write one byte over the 10 MiB limit', async () => {
  const previousRoot = process.env.WORKSPACE_ROOT;
  const previousMax = process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
  const previousWarn = process.env.WORKSPACE_DISK_WARN_RATIO;
  const previousBlock = process.env.WORKSPACE_DISK_BLOCK_RATIO;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'agent-file-tool-max-'));
  process.env.WORKSPACE_DISK_WARN_RATIO = '1';
  process.env.WORKSPACE_DISK_BLOCK_RATIO = '1';
  delete process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
  try {
    await assert.rejects(
      () => userFileTools.write_file.execute!(
        { path: 'huge.txt', content: 'x'.repeat(10 * 1024 * 1024 + 1) } as never,
        toolContext(THREAD_ID),
      ),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FILE_TOO_LARGE',
    );
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
    if (previousMax === undefined) delete process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
    else process.env.WORKSPACE_MAX_FILE_SIZE_BYTES = previousMax;
    if (previousWarn === undefined) delete process.env.WORKSPACE_DISK_WARN_RATIO;
    else process.env.WORKSPACE_DISK_WARN_RATIO = previousWarn;
    if (previousBlock === undefined) delete process.env.WORKSPACE_DISK_BLOCK_RATIO;
    else process.env.WORKSPACE_DISK_BLOCK_RATIO = previousBlock;
  }
});

test('edit tool replaces once and returns applicationPath without host paths', async () => {
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'agent-file-edit-'));
  try {
    assert.equal(
      (userFileTools.edit.inputSchema as { safeParse(value: unknown): { success: boolean } })
        .safeParse({
          path: 'reports/a.md',
          oldText: 'old',
          newText: 'new',
          expectedEtag: `"${'a'.repeat(64)}"`,
        }).success,
      true,
    );
    await userFileTools.write_file.execute!(
      { path: 'reports/a.md', content: 'line old line' } as never,
      toolContext(THREAD_ID),
    );
    const read = await userFileTools.read_file.execute!(
      { path: 'reports/a.md' } as never,
      toolContext(THREAD_ID),
    ) as { etag: string };
    const result = await userFileTools.edit.execute!(
      {
        path: 'reports/a.md',
        oldText: 'old',
        newText: 'new',
        expectedEtag: read.etag,
      } as never,
      toolContext(THREAD_ID),
    ) as {
      path: string;
      etag: string;
      size: number;
      applicationPath: string;
      replacements: number;
    };
    assert.equal(result.path, 'reports/a.md');
    assert.equal(result.replacements, 1);
    assert.equal(result.size, Buffer.byteLength('line new line'));
    assert.match(result.etag, /^"[0-9a-f]{64}"$/);
    assert.equal(result.applicationPath, `/user-files/${THREAD_ID}/reports/a.md`);
    assert.ok(!result.applicationPath.includes(process.env.WORKSPACE_ROOT!));
    assert.ok(!result.applicationPath.includes(tmpdir()));
    assert.equal(
      await readFile(join(
        process.env.WORKSPACE_ROOT!,
        'users', USER_ID, 'workspace', 'threads', THREAD_ID, 'reports', 'a.md',
      ), 'utf8'),
      'line new line',
    );

    await userFileTools.write_file.execute!(
      { path: 'docs/spaced name.md', content: 'only once' } as never,
      toolContext(THREAD_ID),
    );
    const spaced = await userFileTools.read_file.execute!(
      { path: 'docs/spaced name.md' } as never,
      toolContext(THREAD_ID),
    ) as { etag: string };
    const spacedEdit = await userFileTools.edit.execute!(
      {
        path: 'docs/spaced name.md',
        oldText: 'once',
        newText: 'twice',
        expectedEtag: spaced.etag,
      } as never,
      toolContext(THREAD_ID),
    ) as { applicationPath: string };
    assert.equal(
      spacedEdit.applicationPath,
      `/user-files/${THREAD_ID}/docs/${encodeURIComponent('spaced name.md')}`,
    );

    await userFileTools.write_file.execute!(
      { path: 'docs/trim.md', content: 'leave me' } as never,
      toolContext(THREAD_ID),
    );
    await userFileTools.write_file.execute!(
      { path: '  docs/trim.md  ', content: 'pad me' } as never,
      toolContext(THREAD_ID),
    );
    const trimRead = await userFileTools.read_file.execute!(
      { path: '  docs/trim.md  ' } as never,
      toolContext(THREAD_ID),
    ) as { etag: string };
    const trimmedEdit = await userFileTools.edit.execute!(
      {
        path: '  docs/trim.md  ',
        oldText: 'pad',
        newText: 'cut',
        expectedEtag: trimRead.etag,
      } as never,
      toolContext(THREAD_ID),
    ) as { path: string; applicationPath: string };
    assert.equal(trimmedEdit.path, '  docs/trim.md  ');
    assert.equal(trimmedEdit.applicationPath, `/user-files/${THREAD_ID}/${encodeURIComponent('  docs')}/${encodeURIComponent('trim.md  ')}`);
    assert.equal(
      await readFile(join(
        process.env.WORKSPACE_ROOT!,
        'users', USER_ID, 'workspace', 'threads', THREAD_ID, '  docs', 'trim.md  ',
      ), 'utf8'),
      'cut me',
    );
    assert.equal(await readFile(join(process.env.WORKSPACE_ROOT!, 'users', USER_ID,
      'workspace', 'threads', THREAD_ID, 'docs', 'trim.md'), 'utf8'), 'leave me');
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('edit tool workspace scope uses encoded applicationPath and rejects stale etag', async () => {
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'agent-file-edit-ws-'));
  try {
    const uploadRel = 'uploads/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/note.txt';
    const uploadDir = join(
      process.env.WORKSPACE_ROOT!,
      'users', USER_ID, 'workspace',
      'uploads', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, 'note.txt'), 'alpha beta');
    const grep = await userFileTools.grep.execute!(
      { query: 'alpha', scope: 'workspace', basePath: 'uploads' } as never,
      toolContext(THREAD_ID),
    ) as { matches: Array<{ path: string; etag: string }> };
    const match = grep.matches.find(m => m.path === uploadRel);
    assert.ok(match);
    const result = await userFileTools.edit.execute!(
      {
        path: uploadRel,
        oldText: 'beta',
        newText: 'gamma',
        expectedEtag: match!.etag,
        scope: 'workspace',
      } as never,
      toolContext(THREAD_ID),
    ) as { applicationPath: string; replacements: number };
    assert.equal(result.replacements, 1);
    assert.equal(
      result.applicationPath,
      `/current-workspace/files/uploads/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/note.txt`,
    );
    assert.ok(!result.applicationPath.includes(process.env.WORKSPACE_ROOT!));
    await assert.rejects(
      () => userFileTools.edit.execute!(
        {
          path: uploadRel,
          oldText: 'gamma',
          newText: 'delta',
          expectedEtag: match!.etag,
          scope: 'workspace',
        } as never,
        toolContext(THREAD_ID),
      ),
      (error: unknown) => error instanceof Error
        && ('code' in error ? (error as { code?: string }).code === 'STALE_VERSION' : /版本|stale|修改/i.test(error.message)),
    );
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
  }
});

test('userFileTools registers glob, grep and edit with Zod schemas', () => {
  assert.equal(userFileTools.glob.id, 'glob');
  assert.equal(userFileTools.grep.id, 'grep');
  assert.equal(userFileTools.edit.id, 'edit');
  assert.equal(schemaAccepts(userFileTools.glob, { pattern: '**/*.md' }), true);
  assert.equal(schemaAccepts(userFileTools.glob, { pattern: '**/*.md', scope: 'workspace', basePath: 'uploads' }), true);
  assert.equal(schemaAccepts(userFileTools.grep, { query: 'hello' }), true);
  assert.equal(schemaAccepts(userFileTools.grep, {
    query: 'hello',
    scope: 'workspace',
    filePattern: '**/*.txt',
    caseSensitive: false,
  }), true);
  assert.equal(schemaAccepts(userFileTools.edit, {
    path: 'reports/a.md',
    oldText: 'a',
    newText: 'b',
    expectedEtag: `"${'0'.repeat(64)}"`,
  }), true);
  assert.equal(schemaAccepts(userFileTools.edit, {
    path: 'uploads/x/note.txt',
    oldText: 'a',
    newText: '',
    expectedEtag: `"${'0'.repeat(64)}"`,
    scope: 'workspace',
  }), true);
});

test('resolveAgentTools gates glob/grep/edit behind USER_FILES_ENABLED for regular users', () => {
  const previous = process.env.USER_FILES_ENABLED;
  const requestContext = regularUserContext();
  try {
    process.env.USER_FILES_ENABLED = 'false';
    const disabled = listAgentToolIds(requestContext);
    assert.ok(!disabled.includes('glob'));
    assert.ok(!disabled.includes('grep'));
    assert.ok(!disabled.includes('edit'));
    assert.ok(!disabled.includes('read_file'));

    process.env.USER_FILES_ENABLED = 'true';
    const enabled = listAgentToolIds(requestContext);
    assert.ok(enabled.includes('glob'));
    assert.ok(enabled.includes('grep'));
    assert.ok(enabled.includes('edit'));
    assert.ok(enabled.includes('read_file'));
    assert.ok(enabled.includes('read_attached_file'));
  } finally {
    if (previous === undefined) delete process.env.USER_FILES_ENABLED;
    else process.env.USER_FILES_ENABLED = previous;
  }
});

test('agent instructions guide glob→grep/read_file→edit, ETag reuse, STALE_VERSION and attachments', async () => {
  const instructions = String(await agent.getInstructions());
  assert.match(instructions, /glob/i);
  assert.match(instructions, /grep/i);
  assert.match(instructions, /\bedit\b/i);
  assert.match(instructions, /ETag|etag/i);
  assert.match(instructions, /STALE_VERSION|版本冲突|重新读/i);
  assert.match(instructions, /read_attached_file/);
  assert.match(instructions, /workspace|个人工作区/);
  assert.match(instructions, /宿主|绝对路径|file:/);
});

test('end-to-end file flow: glob → grep → edit → re-read, then workspace upload search', async () => {
  const previousRoot = process.env.WORKSPACE_ROOT;
  const previousEnabled = process.env.USER_FILES_ENABLED;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'agent-file-e2e-'));
  process.env.USER_FILES_ENABLED = 'true';
  const hostRoot = process.env.WORKSPACE_ROOT!;
  try {
    await userFileTools.write_file.execute!(
      { path: 'reports/a.md', content: '# Title\nfind-me unique-token\n' } as never,
      toolContext(THREAD_ID),
    );

    const found = await userFileTools.glob.execute!(
      { pattern: '**/a.md' } as never,
      toolContext(THREAD_ID),
    ) as { entries: Array<{ path: string }>; truncated: boolean };
    assert.equal(found.truncated, false);
    assert.ok(found.entries.some(e => e.path === 'reports/a.md'));
    for (const entry of found.entries) {
      assert.ok(!entry.path.includes(hostRoot));
      assert.ok(!entry.path.startsWith('/'));
    }

    const grepped = await userFileTools.grep.execute!(
      { query: 'unique-token' } as never,
      toolContext(THREAD_ID),
    ) as {
      matches: Array<{ path: string; lineNumber: number; line: string; etag: string }>;
      truncated: boolean;
    };
    assert.equal(grepped.truncated, false);
    const hit = grepped.matches.find(m => m.path === 'reports/a.md');
    assert.ok(hit);
    assert.equal(hit!.lineNumber, 2);
    assert.match(hit!.etag, /^"[0-9a-f]{64}"$/);
    assert.ok(!JSON.stringify(grepped).includes(hostRoot));

    const edited = await userFileTools.edit.execute!(
      {
        path: 'reports/a.md',
        oldText: 'unique-token',
        newText: 'replaced-token',
        expectedEtag: hit!.etag,
      } as never,
      toolContext(THREAD_ID),
    ) as { path: string; etag: string; size: number; applicationPath: string; replacements: number };
    assert.equal(edited.replacements, 1);
    assert.equal(edited.path, 'reports/a.md');
    assert.ok(!edited.applicationPath.includes(hostRoot));
    assert.ok(!edited.applicationPath.includes(tmpdir()));
    assert.match(edited.applicationPath, new RegExp(`^/user-files/${THREAD_ID}/`));

    const reread = await userFileTools.read_file.execute!(
      { path: 'reports/a.md' } as never,
      toolContext(THREAD_ID),
    ) as { content: string; etag: string; size: number };
    assert.match(reread.content, /replaced-token/);
    assert.ok(!reread.content.includes('unique-token'));
    assert.equal(reread.etag, edited.etag);
    assert.equal(reread.size, edited.size);
    assert.ok(!JSON.stringify(reread).includes(hostRoot));

    const uploadRel = `uploads/${UPLOAD_UUID}/note.txt`;
    const uploadDir = join(hostRoot, 'users', USER_ID, 'workspace', 'uploads', UPLOAD_UUID);
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, 'note.txt'), 'workspace-only secret-note\n');

    const defaultMiss = await userFileTools.glob.execute!(
      { pattern: '**/note.txt' } as never,
      toolContext(THREAD_ID),
    ) as { entries: Array<{ path: string }> };
    assert.ok(!defaultMiss.entries.some(e => e.path.includes('note.txt')));

    const workspaceHit = await userFileTools.glob.execute!(
      { pattern: '**/note.txt', scope: 'workspace' } as never,
      toolContext(THREAD_ID),
    ) as { entries: Array<{ path: string }> };
    assert.ok(workspaceHit.entries.some(e => e.path === uploadRel));
    for (const entry of workspaceHit.entries) {
      assert.ok(!entry.path.includes(hostRoot));
    }

    const workspaceGrep = await userFileTools.grep.execute!(
      { query: 'secret-note', scope: 'workspace', basePath: `uploads/${UPLOAD_UUID}` } as never,
      toolContext(THREAD_ID),
    ) as { matches: Array<{ path: string; etag: string }> };
    assert.ok(workspaceGrep.matches.some(m => m.path === uploadRel));
    assert.ok(!JSON.stringify(workspaceGrep).includes(hostRoot));
  } finally {
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
    if (previousEnabled === undefined) delete process.env.USER_FILES_ENABLED;
    else process.env.USER_FILES_ENABLED = previousEnabled;
  }
});
