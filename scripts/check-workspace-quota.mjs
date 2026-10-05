#!/usr/bin/env node
import { open, readdir, statfs, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const directory = process.env.WORKSPACE_QUOTA_PROBE_DIR;
const limit = Number(process.env.WORKSPACE_QUOTA_PROBE_LIMIT_BYTES);
const chunkSize = 1024 * 1024;

if (!directory || !Number.isSafeInteger(limit) || limit < chunkSize || limit > 1_000_000_000_000) {
  console.error('Set WORKSPACE_QUOTA_PROBE_DIR to an empty project-quota directory and WORKSPACE_QUOTA_PROBE_LIMIT_BYTES to its configured byte limit.');
  process.exit(1);
}

const target = resolve(directory);
const probe = join(target, `.quota-probe-${process.pid}`);
let handle;
let written = 0;
let hitQuota = false;
try {
  if ((await readdir(target)).length !== 0) throw new Error('Probe directory must be empty');
  const before = await statfs(target);
  if (before.bavail * before.bsize < limit * 2) throw new Error('Host filesystem has insufficient free space for a safe quota probe');
  handle = await open(probe, 'wx');
  const chunk = Buffer.alloc(chunkSize);
  while (written <= limit + chunkSize) {
    try {
      const { bytesWritten } = await handle.write(chunk);
      written += bytesWritten;
      await handle.sync();
    } catch (error) {
      if (!['EDQUOT', 'ENOSPC'].includes(error.code)) throw error;
      const after = await statfs(target);
      if (after.bavail * after.bsize < limit) throw new Error('Host filesystem ran low; quota enforcement was not proven');
      hitQuota = true;
      break;
    }
  }
  if (!hitQuota) throw new Error('No project quota stopped writes beyond the configured limit');
  if (written < limit * 0.9) throw new Error('Quota blocked writes well below the configured limit');
  console.log(`Project quota enforcement verified at ${written} bytes; host filesystem still has free space.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await handle?.close().catch(() => undefined);
  await unlink(probe).catch(() => undefined);
}
