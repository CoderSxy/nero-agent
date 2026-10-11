import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const guardScript = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/check-indexed-db.mjs');

function runGuard(root: string): number {
  const result = spawnSync(process.execPath, [guardScript, '--root', root], {
    encoding: 'utf8',
  });
  return result.status ?? 1;
}

describe('check-indexed-db guard', () => {
  let tempRoot: string;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  it('fails when production code calls indexedDB.open outside the shared module', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'idb-guard-'));
    await mkdir(join(tempRoot, 'feature'), { recursive: true });
    await writeFile(
      join(tempRoot, 'feature', 'bad.ts'),
      "export function bad() { return indexedDB.open('second-db'); }\n",
    );
    expect(runGuard(tempRoot)).not.toBe(0);
  });

  it('passes when only the shared storage module opens IndexedDB', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'idb-guard-'));
    await mkdir(join(tempRoot, 'storage'), { recursive: true });
    await writeFile(
      join(tempRoot, 'storage', 'indexed-db.ts'),
      "export function open() { return indexedDB.open('nero-agent-client', 1); }\n",
    );
    await writeFile(join(tempRoot, 'app.ts'), "import './storage/indexed-db';\n");
    expect(runGuard(tempRoot)).toBe(0);
  });
});
