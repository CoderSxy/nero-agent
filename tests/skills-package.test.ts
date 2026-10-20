/**
 * Task 1: skill package validation / ZIP import preview (no HTTP/repo).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import {
  SKILL_LIMITS as APP_SKILL_LIMITS,
  parseSkillPackage,
  previewSkillZip,
  validateSkillMd,
} from '../src/mastra/skills/package.ts';
import { SkillPackageError } from '../src/mastra/skills/errors.ts';
import { getSkillsImportTempRoot } from '../src/mastra/skills/config.ts';

type FileEntry = { path: string; bytes: Uint8Array };

async function* asAsyncFiles(files: FileEntry[]): AsyncIterable<FileEntry> {
  for (const file of files) yield file;
}

function skillMd(name: string, description: string, body = '# Instructions\nDo the thing.\n'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function buildZip(entries: Array<{ path: string; bytes?: Uint8Array; text?: string; directory?: boolean; unixMode?: number }>): Promise<Uint8Array> {
  const writer = new ZipWriter(new BlobWriter('application/zip'), {
    bufferedWrite: true,
  });
  for (const entry of entries) {
    if (entry.directory) {
      await writer.add(entry.path.endsWith('/') ? entry.path : `${entry.path}/`, undefined, {
        directory: true,
        unixMode: entry.unixMode,
      });
      continue;
    }
    const data = entry.bytes ?? utf8(entry.text ?? '');
    await writer.add(entry.path, new Uint8ArrayReader(data), {
      unixMode: entry.unixMode,
    });
  }
  const blob = await writer.close();
  return new Uint8Array(await blob.arrayBuffer());
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeBytes(size: number, fill = 0x61): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

test('valid_standard_bundle keeps body, resource trees, and Chinese paths', async () => {
  const md = skillMd('demo-skill', 'A standard demo skill for package tests.', '## Steps\n1. Read refs\n');
  const files: FileEntry[] = [
    { path: 'SKILL.md', bytes: utf8(md) },
    { path: 'references/说明.md', bytes: utf8('# 说明\n中文参考\n') },
    { path: 'scripts/run.sh', bytes: utf8('#!/bin/sh\necho ok\n') },
    { path: 'assets/图标.txt', bytes: utf8('icon-placeholder\n') },
    { path: 'skill-runtime.json', bytes: utf8(JSON.stringify({
      schemaVersion: 1,
      runtimes: ['bash'],
      entrypoints: ['scripts/run.sh'],
      requiredTools: [],
      network: 'none',
    })) },
  ];

  const pkg = await parseSkillPackage(asAsyncFiles(files));
  assert.equal(pkg.canonicalName, 'demo-skill');
  assert.equal(pkg.sourceName, 'demo-skill');
  assert.equal(pkg.description, 'A standard demo skill for package tests.');
  assert.match(pkg.skillMd, /## Steps/);
  assert.equal(pkg.requiresNameAcceptance, false);
  assert.ok(pkg.runtimeManifest);
  assert.equal(pkg.runtimeManifest?.schemaVersion, 1);

  const paths = pkg.resources.map(r => r.path).sort();
  assert.deepEqual(paths, [
    'assets/图标.txt',
    'references/说明.md',
    'scripts/run.sh',
    'skill-runtime.json',
  ].sort());
  const chinese = pkg.resources.find(r => r.path === 'references/说明.md');
  assert.ok(chinese);
  assert.equal(new TextDecoder().decode(chinese.bytes), '# 说明\n中文参考\n');
});

test('noncanonical_name_requires_acceptance does not silently rewrite or overwrite', async () => {
  const md = skillMd('legacy_name', 'Legacy underscore skill from reference project.');
  const pkg = await parseSkillPackage(asAsyncFiles([
    { path: 'SKILL.md', bytes: utf8(md) },
  ]));

  assert.equal(pkg.sourceName, 'legacy_name');
  assert.equal(pkg.suggestedCanonicalName, 'legacy-name');
  assert.equal(pkg.requiresNameAcceptance, true);
  // Must NOT silently treat rewritten name as accepted canonical covering existing skills.
  assert.notEqual(pkg.canonicalName, 'legacy-name');
  assert.equal(pkg.canonicalName, '');
  assert.ok(pkg.warnings.some(w => /accept|规范|canonical|name/i.test(w)));
});

test('validateSkillMd returns errors and does not invent success for missing description', () => {
  const result = validateSkillMd('---\nname: ok-skill\n---\nbody\n', 'ok-skill');
  assert.ok(result.errors.length > 0);
  assert.equal(result.valid, false);
});

test('validateSkillMd accepts a valid standard document', () => {
  const result = validateSkillMd(
    skillMd('ok-skill', 'Valid description for unit test.'),
    'ok-skill',
  );
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.metadata);
});

test('strips a single outer wrapper directory', async () => {
  const md = skillMd('wrap-skill', 'Wrapped package skill.');
  const pkg = await parseSkillPackage(asAsyncFiles([
    { path: 'wrap-skill/SKILL.md', bytes: utf8(md) },
    { path: 'wrap-skill/references/a.md', bytes: utf8('a') },
  ]));
  assert.equal(pkg.canonicalName, 'wrap-skill');
  assert.ok(pkg.resources.some(r => r.path === 'references/a.md'));
  assert.ok(!pkg.resources.some(r => r.path.startsWith('wrap-skill/')));
});

test('rejects missing SKILL.md', async () => {
  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles([{ path: 'references/a.md', bytes: utf8('x') }])),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'SKILL_MD_MISSING',
  );
});

test('rejects multiple root SKILL.md after unwrap', async () => {
  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles([
      { path: 'a/SKILL.md', bytes: utf8(skillMd('a-skill', 'desc a')) },
      { path: 'b/SKILL.md', bytes: utf8(skillMd('b-skill', 'desc b')) },
    ])),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'SKILL_MD_AMBIGUOUS',
  );
});

test('rejects unknown skill-runtime schemaVersion', async () => {
  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles([
      { path: 'SKILL.md', bytes: utf8(skillMd('rt-skill', 'runtime schema test')) },
      { path: 'skill-runtime.json', bytes: utf8(JSON.stringify({ schemaVersion: 99, runtimes: [], entrypoints: [], network: 'none' })) },
    ])),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'RUNTIME_SCHEMA_UNSUPPORTED',
  );
});

test('rejects YAML alias expansion above 20', async () => {
  const aliases = Array.from({ length: 21 }, (_, i) => `a${i}: &a${i} v${i}`).join('\n');
  // Build a document that expands more than 20 aliases via nested anchors.
  const yamlHeavy = `---
name: alias-skill
description: alias bomb
x: &base
  v: 1
y0: *base
y1: *base
y2: *base
y3: *base
y4: *base
y5: *base
y6: *base
y7: *base
y8: *base
y9: *base
y10: *base
y11: *base
y12: *base
y13: *base
y14: *base
y15: *base
y16: *base
y17: *base
y18: *base
y19: *base
y20: *base
---
body
`;
  void aliases;
  const result = validateSkillMd(yamlHeavy, 'alias-skill');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /alias/i.test(e)));
});

test('boundary equals limits are accepted; over-by-one rejected', async () => {
  const maxMd = APP_SKILL_LIMITS.SKILL_MD_MAX_BYTES;
  const mdPrefix = '---\nname: edge-skill\ndescription: d\n---\n';
  const exactMd = mdPrefix + 'x'.repeat(maxMd - mdPrefix.length);
  assert.equal(Buffer.byteLength(exactMd, 'utf8'), maxMd);

  const ok = await parseSkillPackage(asAsyncFiles([
    { path: 'SKILL.md', bytes: utf8(exactMd) },
  ]));
  assert.equal(ok.canonicalName, 'edge-skill');

  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles([
      { path: 'SKILL.md', bytes: utf8(exactMd + '!') },
    ])),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'SKILL_MD_TOO_LARGE',
  );

  // Max files = 1000 including SKILL.md → 999 resources + SKILL.md
  const maxFiles = APP_SKILL_LIMITS.MAX_FILES;
  const exactFiles: FileEntry[] = [{ path: 'SKILL.md', bytes: utf8(skillMd('file-edge', 'file count edge')) }];
  for (let i = 0; i < maxFiles - 1; i++) {
    exactFiles.push({ path: `references/f${i}.txt`, bytes: utf8('x') });
  }
  const exactPkg = await parseSkillPackage(asAsyncFiles(exactFiles));
  assert.equal(exactPkg.resources.length, maxFiles - 1);

  const overFiles = exactFiles.concat([{ path: 'references/overflow.txt', bytes: utf8('x') }]);
  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles(overFiles)),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'TOO_MANY_FILES',
  );

  const maxFile = APP_SKILL_LIMITS.FILE_MAX_BYTES;
  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles([
      { path: 'SKILL.md', bytes: utf8(skillMd('big-file', 'single file over limit')) },
      { path: 'assets/big.bin', bytes: makeBytes(maxFile + 1, 0) },
    ])),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'FILE_TOO_LARGE',
  );

  // Each file ≤ FILE_MAX; combined with SKILL.md exceeds VERSION_TOTAL.
  const perFile = APP_SKILL_LIMITS.FILE_MAX_BYTES;
  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles([
      { path: 'SKILL.md', bytes: utf8(skillMd('tot-skill', 'total size over')) },
      { path: 'assets/a.bin', bytes: makeBytes(perFile, 1) },
      { path: 'assets/b.bin', bytes: makeBytes(perFile, 2) },
    ])),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'VERSION_TOO_LARGE',
  );

  const jsonLimit = APP_SKILL_LIMITS.JSON_MAX_BYTES;
  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles([
      { path: 'SKILL.md', bytes: utf8(skillMd('json-skill', 'json over limit')) },
      { path: 'skill-runtime.json', bytes: utf8(`{"schemaVersion":1,"runtimes":[],"entrypoints":[],"network":"none","pad":"${'p'.repeat(jsonLimit)}"}`) },
    ])),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'JSON_TOO_LARGE',
  );
});

test('rejects path traversal, backslash, absolute, NUL, and empty segments', async () => {
  const badResourcePaths = ['refs\\a.md', 'a/\0/b.md', 'a//b.md', 'a/./b.md', 'a/../b.md'];
  for (const path of badResourcePaths) {
    await assert.rejects(
      () => parseSkillPackage(asAsyncFiles([
        { path: 'SKILL.md', bytes: utf8(skillMd('path-skill', 'path checks')) },
        { path, bytes: utf8('x') },
      ])),
      (err: unknown) => err instanceof SkillPackageError && err.code === 'PATH_INVALID',
      `expected reject for ${path}`,
    );
  }

  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles([
      { path: '../SKILL.md', bytes: utf8(skillMd('path-skill', 'path checks')) },
    ])),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'PATH_INVALID',
  );

  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles([
      { path: '/abs/SKILL.md', bytes: utf8(skillMd('path-skill', 'path checks')) },
    ])),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'PATH_INVALID',
  );
});

test('rejects duplicate paths and Unicode NFC / case-fold collisions', async () => {
  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles([
      { path: 'SKILL.md', bytes: utf8(skillMd('dup-skill', 'dup path')) },
      { path: 'references/A.txt', bytes: utf8('A') },
      { path: 'references/a.txt', bytes: utf8('a') },
    ])),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'PATH_COLLISION',
  );

  // café in NFD vs NFC
  const nfc = 'references/caf\u00e9.txt';
  const nfd = 'references/cafe\u0301.txt';
  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles([
      { path: 'SKILL.md', bytes: utf8(skillMd('nfc-skill', 'unicode path')) },
      { path: nfc, bytes: utf8('1') },
      { path: nfd, bytes: utf8('2') },
    ])),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'PATH_COLLISION',
  );
});

test('rejects binary content when SKILL.md is not valid UTF-8 text', async () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x01, 0x02]);
  await assert.rejects(
    () => parseSkillPackage(asAsyncFiles([{ path: 'SKILL.md', bytes }])),
    (err: unknown) => err instanceof SkillPackageError && err.code === 'SKILL_MD_BINARY',
  );
});

test('previewSkillZip accepts a valid zip and keeps files under import temp root', async () => {
  const prev = process.env.SKILLS_IMPORT_TEMP_ROOT;
  const tempRoot = await mkdtemp(join(tmpdir(), 'skills-import-root-'));
  process.env.SKILLS_IMPORT_TEMP_ROOT = tempRoot;
  try {
    const zipBytes = await buildZip([
      { path: 'demo-skill/SKILL.md', text: skillMd('demo-skill', 'zip preview skill') },
      { path: 'demo-skill/references/说明.md', text: '中文' },
    ]);
    assert.ok(zipBytes.byteLength <= APP_SKILL_LIMITS.ZIP_MAX_BYTES);

    const preview = await previewSkillZip(streamFromBytes(zipBytes));
    assert.ok(preview.importId);
    assert.equal(preview.package.canonicalName, 'demo-skill');
    assert.ok(preview.tempRoot.startsWith(resolve(tempRoot)));
    assert.ok(preview.expiresAt.getTime() > Date.now());

    const skillStat = await stat(join(preview.tempRoot, 'SKILL.md'));
    assert.ok(skillStat.isFile());
  } finally {
    if (prev === undefined) delete process.env.SKILLS_IMPORT_TEMP_ROOT;
    else process.env.SKILLS_IMPORT_TEMP_ROOT = prev;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('previewSkillZip rejects zip over size limit while streaming', async () => {
  const prev = process.env.SKILLS_IMPORT_TEMP_ROOT;
  const tempRoot = await mkdtemp(join(tmpdir(), 'skills-import-root-'));
  process.env.SKILLS_IMPORT_TEMP_ROOT = tempRoot;
  const markerOutside = join(tempRoot, '..', `outside-${randomUUID()}.txt`);
  try {
    const over = APP_SKILL_LIMITS.ZIP_MAX_BYTES + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = makeBytes(1024 * 1024, 7);
        let sent = 0;
        while (sent < over) {
          const n = Math.min(chunk.byteLength, over - sent);
          controller.enqueue(chunk.subarray(0, n));
          sent += n;
        }
        controller.close();
      },
    });
    await assert.rejects(
      () => previewSkillZip(stream),
      (err: unknown) => err instanceof SkillPackageError && err.code === 'ZIP_TOO_LARGE',
    );
    await assert.rejects(() => stat(markerOutside));
    // Failure must not leave extract trees under temp root (may leave nothing or cleaned).
    const leftover = await readdir(tempRoot);
    assert.equal(leftover.length, 0);
  } finally {
    if (prev === undefined) delete process.env.SKILLS_IMPORT_TEMP_ROOT;
    else process.env.SKILLS_IMPORT_TEMP_ROOT = prev;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('previewSkillZip rejects symlink, hardlink marker, and device entries', async () => {
  const prev = process.env.SKILLS_IMPORT_TEMP_ROOT;
  const tempRoot = await mkdtemp(join(tmpdir(), 'skills-import-root-'));
  process.env.SKILLS_IMPORT_TEMP_ROOT = tempRoot;
  try {
    const symlinkZip = await buildZip([
      { path: 'SKILL.md', text: skillMd('link-skill', 'has symlink') },
      { path: 'references/link', text: '../outside', unixMode: 0o120777 },
    ]);
    await assert.rejects(
      () => previewSkillZip(streamFromBytes(symlinkZip)),
      (err: unknown) => err instanceof SkillPackageError && err.code === 'PATH_SYMLINK',
    );

    // Hardlink: Info-ZIP-style regular file with nlink>1 encoded in comment convention used by our writer helper.
    const hardlinkZip = await buildZip([
      { path: 'SKILL.md', text: skillMd('hard-skill', 'has hardlink') },
      { path: 'assets/a.txt', text: 'same', unixMode: 0o100644 },
      { path: 'assets/b.txt', text: 'same', unixMode: 0o100644 },
    ]);
    // Inject hardlink marker via a dedicated entry type bit we recognize: S_IFREG with setuid+external "hardlink" comment.
    // Implementation rejects entries whose Zip comment starts with "hardlink:" (test fixture convention) OR unixMode hardlink pack.
    const hardWriter = new ZipWriter(new BlobWriter('application/zip'), { bufferedWrite: true });
    await hardWriter.add('SKILL.md', new TextReader(skillMd('hard-skill', 'has hardlink')));
    await hardWriter.add('assets/a.txt', new TextReader('same'), { comment: 'hardlink:assets/b.txt', unixMode: 0o100644 });
    const hardBlob = await hardWriter.close();
    const hardBytes = new Uint8Array(await hardBlob.arrayBuffer());
    void hardlinkZip;
    await assert.rejects(
      () => previewSkillZip(streamFromBytes(hardBytes)),
      (err: unknown) => err instanceof SkillPackageError && err.code === 'PATH_HARDLINK',
    );

    const deviceZip = await buildZip([
      { path: 'SKILL.md', text: skillMd('dev-skill', 'has device') },
      { path: 'assets/null', text: '', unixMode: 0o020666 },
    ]);
    await assert.rejects(
      () => previewSkillZip(streamFromBytes(deviceZip)),
      (err: unknown) => err instanceof SkillPackageError && err.code === 'PATH_SPECIAL_FILE',
    );
  } finally {
    if (prev === undefined) delete process.env.SKILLS_IMPORT_TEMP_ROOT;
    else process.env.SKILLS_IMPORT_TEMP_ROOT = prev;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('previewSkillZip rejects declared uncompressed total over version limit before finishing extract', async () => {
  const prev = process.env.SKILLS_IMPORT_TEMP_ROOT;
  const tempRoot = await mkdtemp(join(tmpdir(), 'skills-import-root-'));
  process.env.SKILLS_IMPORT_TEMP_ROOT = tempRoot;
  try {
    // Three ~70MiB entries: each under FILE_MAX, declared total over VERSION_TOTAL.
    const chunk = Math.floor(APP_SKILL_LIMITS.VERSION_TOTAL_MAX_BYTES / 3) + 1024;
    const zipBytes = await buildZip([
      { path: 'SKILL.md', text: skillMd('bomb-skill', 'zip bomb-ish') },
      { path: 'assets/a.bin', bytes: makeBytes(chunk, 9) },
      { path: 'assets/b.bin', bytes: makeBytes(chunk, 9) },
      { path: 'assets/c.bin', bytes: makeBytes(chunk, 9) },
    ]);
    await assert.rejects(
      () => previewSkillZip(streamFromBytes(zipBytes)),
      (err: unknown) => err instanceof SkillPackageError && (
        err.code === 'VERSION_TOO_LARGE' || err.code === 'ZIP_EXPAND_TOO_LARGE'
      ),
    );
    const leftover = await readdir(tempRoot);
    assert.equal(leftover.length, 0);
  } finally {
    if (prev === undefined) delete process.env.SKILLS_IMPORT_TEMP_ROOT;
    else process.env.SKILLS_IMPORT_TEMP_ROOT = prev;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('failed preview does not write outside the configured import temp root', async () => {
  const prev = process.env.SKILLS_IMPORT_TEMP_ROOT;
  const tempRoot = await mkdtemp(join(tmpdir(), 'skills-import-root-'));
  process.env.SKILLS_IMPORT_TEMP_ROOT = tempRoot;
  const outside = resolve(tempRoot, '..');
  const before = new Set(await readdir(outside));
  try {
    const zipBytes = await buildZip([
      { path: '../escape.txt', text: 'nope' },
      { path: 'SKILL.md', text: skillMd('esc-skill', 'escape attempt') },
    ]);
    await assert.rejects(() => previewSkillZip(streamFromBytes(zipBytes)));
    const after = await readdir(outside);
    for (const name of after) {
      if (!before.has(name) && name.startsWith('escape')) {
        assert.fail(`unexpected outside file: ${name}`);
      }
    }
    // ensure marker file was not created beside temp root
    await assert.rejects(() => readFile(join(outside, 'escape.txt')));
  } finally {
    if (prev === undefined) delete process.env.SKILLS_IMPORT_TEMP_ROOT;
    else process.env.SKILLS_IMPORT_TEMP_ROOT = prev;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('getSkillsImportTempRoot requires explicit configuration for preview writes', () => {
  const prev = process.env.SKILLS_IMPORT_TEMP_ROOT;
  delete process.env.SKILLS_IMPORT_TEMP_ROOT;
  try {
    assert.throws(() => getSkillsImportTempRoot(), /SKILLS_IMPORT_TEMP_ROOT|temp/i);
  } finally {
    if (prev !== undefined) process.env.SKILLS_IMPORT_TEMP_ROOT = prev;
  }
});

test('APP_SKILL_LIMITS exposes spec constants', () => {
  assert.equal(APP_SKILL_LIMITS.SKILL_MD_MAX_BYTES, 128 * 1024);
  assert.equal(APP_SKILL_LIMITS.TEXT_READ_MAX_BYTES, 64 * 1024);
  assert.equal(APP_SKILL_LIMITS.TEXT_READ_MAX_LINES, 400);
  assert.equal(APP_SKILL_LIMITS.TEXT_READ_DEFAULT_LINES, 200);
  assert.equal(APP_SKILL_LIMITS.FILE_MAX_BYTES, 100 * 1024 * 1024);
  assert.equal(APP_SKILL_LIMITS.VERSION_TOTAL_MAX_BYTES, 200 * 1024 * 1024);
  assert.equal(APP_SKILL_LIMITS.MAX_FILES, 1000);
  assert.equal(APP_SKILL_LIMITS.ZIP_MAX_BYTES, 100 * 1024 * 1024);
  assert.equal(APP_SKILL_LIMITS.JSON_MAX_BYTES, 256 * 1024);
  assert.equal(APP_SKILL_LIMITS.PATH_MAX_CHARS, 512);
  assert.equal(APP_SKILL_LIMITS.YAML_MAX_ALIAS_EXPANSIONS, 20);
  assert.equal(APP_SKILL_LIMITS.PAGE_DEFAULT, 20);
  assert.equal(APP_SKILL_LIMITS.PAGE_MAX, 50);
});
