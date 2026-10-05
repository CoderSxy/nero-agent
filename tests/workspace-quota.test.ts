import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import { FileService } from '../src/mastra/files/service';
import { QuotaExceededError, WorkspaceQuota } from '../src/mastra/workspace/quota';
import { assertHostQuotaReady, assertWritable, DiskProtectionError } from '../src/mastra/workspace/disk-protection';

const USER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const USER_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const USER_C = 'cccccccc-3333-4333-8333-333333333333';

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

test('two concurrent reserves that together exceed quota only commit one', async () => {
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '1000';
  const quota = new WorkspaceQuota();
  const attempts = await Promise.allSettled([
    quota.reserve(USER_A, 600),
    quota.reserve(USER_A, 600),
  ]);
  const ok = attempts.filter(item => item.status === 'fulfilled').length;
  const denied = attempts.filter(item => item.status === 'rejected').length;
  assert.equal(ok, 1);
  assert.equal(denied, 1);
  assert.equal((await quota.usage(USER_A)).usedBytes, 600);
});

test('write and output over quota are rejected', async () => {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-write-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '100';
  const quota = new WorkspaceQuota();
  await quota.reserve(USER_B, 90);
  await assert.rejects(() => quota.reserve(USER_B, 20), QuotaExceededError);
});

test('disk protection thresholds and host quota fail closed', () => {
  process.env.WORKSPACE_DISK_WARN_RATIO = '0.8';
  process.env.WORKSPACE_DISK_BLOCK_RATIO = '0.9';
  assert.doesNotThrow(() => assertWritable(100, 0.5));
  assert.throws(() => assertWritable(11 * 1024 * 1024, 0.81), DiskProtectionError);
  assert.throws(() => assertWritable(1, 0.91), DiskProtectionError);
  delete process.env.WORKSPACE_HOST_QUOTA_VERIFIED;
  delete process.env.SANDBOX_FILE_WRITE_ENABLED;
  assert.throws(() => assertHostQuotaReady(), DiskProtectionError);
});

test('FileService write over remaining quota fails', async () => {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-fs-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '50';
  const service = new FileService({
    getThreadById: async () => ({ id: 't', resourceId: USER_C }),
  });
  await service.write(authContextFromUser(user(USER_C)), 't', 'a.txt', Buffer.alloc(40));
  await assert.rejects(() => service.write(authContextFromUser(user(USER_C)), 't', 'b.txt', Buffer.alloc(40)));
});
