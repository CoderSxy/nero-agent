#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.env.ADMIN_WORKSPACE_SOURCE ?? 'workspace';
console.log(`Listing ${root}. This script does not copy or claim files.`);
console.log('Empty-resourceId threads must not be auto-assigned.');
try {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    const info = entry.isFile() ? await stat(full) : null;
    console.log(`${entry.isDirectory() ? 'dir' : 'file'}\t${full}${info ? `\t${info.size}` : ''}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
