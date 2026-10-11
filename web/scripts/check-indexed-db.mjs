#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_RELATIVE = join('storage', 'indexed-db.ts');

const OPEN_PATTERN = /\bindexedDB\.open\s*\(/;
const DELETE_PATTERN = /\bindexedDB\.deleteDatabase\s*\(/;

function parseArgs(argv) {
  let root = join(fileURLToPath(new URL('..', import.meta.url)), 'src');
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) {
      root = argv[i + 1];
      i += 1;
    }
  }
  return root;
}

function isProductionSource(fileName) {
  if (!/\.(ts|tsx|js|jsx)$/.test(fileName)) return false;
  if (/\.test\.(ts|tsx|js|jsx)$/.test(fileName)) return false;
  return true;
}

async function walk(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, files);
    } else if (isProductionSource(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const root = parseArgs(process.argv);
  const files = await walk(root);
  const violations = [];

  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    if (rel === ALLOWED_RELATIVE.split(sep).join('/')) continue;

    const source = await readFile(file, 'utf8');
    if (OPEN_PATTERN.test(source) || DELETE_PATTERN.test(source)) {
      violations.push(rel);
    }
  }

  if (violations.length > 0) {
    console.error(
      'IndexedDB must only be opened or deleted from web/src/storage/indexed-db.ts.\n' +
        'Violations:\n' +
        violations.map((v) => `  - ${v}`).join('\n'),
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
