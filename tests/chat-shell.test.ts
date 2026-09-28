import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mastraProxyTarget } from '../web/src/dev-proxy.ts';
import {
  formatThreadTime,
  sortThreads,
  threadSubtitle,
  threadTitle,
} from '../web/src/lib/thread-label.ts';

test('dev script starts mastra and the web shell together', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.match(pkg.scripts.dev, /concurrently/);
  assert.match(pkg.scripts.dev, /mastra dev/);
  assert.match(pkg.scripts.dev, /--prefix web/);
  assert.ok(pkg.devDependencies.concurrently);
  assert.equal(mastraProxyTarget, 'http://127.0.0.1:4111');
});

test('thread labels use custom title, then stored title, then a fallback', () => {
  const renamed = {
    id: 'a',
    title: '原始提问',
    createdAt: '2026-09-28T03:12:38.000Z',
    updatedAt: '2026-09-28T04:00:00.000Z',
    metadata: { customTitle: '改过的名字' },
  };
  assert.equal(threadTitle(renamed), '改过的名字');
  assert.equal(threadTitle({ ...renamed, metadata: {} }), '原始提问');
  assert.equal(threadTitle({ id: 'b', createdAt: renamed.createdAt, updatedAt: renamed.updatedAt }), '新对话');
});

test('subtitle prefers updatedAt and does not zero-pad month or day', () => {
  const thread = {
    id: 'a',
    createdAt: '2026-01-02T01:02:03.000Z',
    updatedAt: '2026-09-28T03:12:38.000Z',
  };
  const text = threadSubtitle(thread);
  const expected = formatThreadTime(thread.updatedAt);
  assert.equal(text, expected);
  const local = new Date(thread.updatedAt);
  assert.match(text, new RegExp(`${local.getFullYear()}年${local.getMonth() + 1}月${local.getDate()}日 `));
  assert.doesNotMatch(text, /年09月/);
});

test('sortThreads orders by updatedAt descending', () => {
  const sorted = sortThreads([
    { id: 'old', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ['new', 'old']);
});
