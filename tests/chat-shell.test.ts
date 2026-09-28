import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mastraProxyTarget } from '../web/src/dev-proxy.ts';

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
