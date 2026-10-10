import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import { FileService, FileServiceError } from '../src/mastra/files/service';
import { maxFileSizeBytes } from '../src/mastra/files/policy';
import { QuotaExceededError, WorkspaceQuota } from '../src/mastra/workspace/quota';
import { assertHostQuotaReady, assertHostWritable, assertWritable, DiskProtectionError } from '../src/mastra/workspace/disk-protection';
import { workspaceRoot } from '../src/mastra/workspace/path';

const USER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const USER_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const USER_C = 'cccccccc-3333-4333-8333-333333333333';
const DATABASE_URL = process.env.DATABASE_URL;

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function user(id: string): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles: ['user'] };
}

test('default max file size is exactly 10 MiB', () => {
  const previous = process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
  delete process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
  try {
    assert.equal(maxFileSizeBytes(), 10 * 1024 * 1024);
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
    else process.env.WORKSPACE_MAX_FILE_SIZE_BYTES = previous;
  }
});

test('QuotaExceededError uses a stable WORKSPACE_QUOTA_EXCEEDED code', () => {
  const error = new QuotaExceededError();
  assert.equal(error.code, 'WORKSPACE_QUOTA_EXCEEDED');
});

test('two concurrent reserves that together exceed quota only commit one', async () => {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '1000';
  try {
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
  } finally {
    restoreEnv(env);
  }
});

test('write and output over quota are rejected', async () => {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT', 'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-write-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '100';
  try {
    const quota = new WorkspaceQuota();
    await quota.reserve(USER_B, 90);
    await assert.rejects(() => quota.reserve(USER_B, 20), QuotaExceededError);
  } finally {
    restoreEnv(env);
  }
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
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT', 'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-fs-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '50';
  try {
    const service = new FileService({
      getThreadById: async () => ({ id: 't', resourceId: USER_C }),
    });
    await service.write(authContextFromUser(user(USER_C)), 't', 'a.txt', Buffer.alloc(40));
    await assert.rejects(() => service.write(authContextFromUser(user(USER_C)), 't', 'b.txt', Buffer.alloc(40)));
  } finally {
    restoreEnv(env);
  }
});

test('deleting a file releases its workspace quota', async () => {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT', 'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-delete-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '100';
  try {
    const id = 'eeeeeeee-5555-4555-8555-555555555555';
    const auth = authContextFromUser(user(id));
    const service = new FileService({ getThreadById: async () => ({ id: 't', resourceId: id }) });
    await service.write(auth, 't', 'a.txt', Buffer.alloc(80));
    await service.delete(auth, 't', 'a.txt');
    await service.write(auth, 't', 'b.txt', Buffer.alloc(80));
  } finally {
    restoreEnv(env);
  }
});

test('WorkspaceFileService batchDelete frees quota and rescan matches disk', async () => {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT', 'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-batch-del-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '500';
  try {
    const { WorkspaceFileService } = await import('../src/mastra/files/workspace-service');
    const id = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
    const auth = authContextFromUser(user(id));
    const service = new WorkspaceFileService();
    const first = await service.upload(auth, new File([Buffer.alloc(40)], 'a.bin'));
    const second = await service.upload(auth, new File([Buffer.alloc(60)], 'b.bin'));
    const deleted = await service.batchDelete(auth, [first.path, second.path]);
    assert.equal(deleted.deletedFiles, 2);
    assert.equal(deleted.freedBytes, 100);
    assert.equal(deleted.usage.usedBytes, 0);
    assert.equal(deleted.usage.fileCount, 0);
    const quota = new WorkspaceQuota();
    const scanned = await quota.reconcileFromDisk(id);
    assert.equal(scanned.usedBytes, 0);
    assert.equal(scanned.fileCount, 0);
    assert.equal((await quota.usage(id)).usedBytes, 0);
  } finally {
    restoreEnv(env);
  }
});

test('host disk protection checks filesystem usage independently of user quota', async () => {
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-host-'));
  process.env.WORKSPACE_DISK_BLOCK_RATIO = '0';
  await assert.rejects(() => assertHostWritable(1), DiskProtectionError);
  process.env.WORKSPACE_DISK_BLOCK_RATIO = '0.9';
});

test('FileService accepts a 10 MiB write and rejects one extra byte with FILE_TOO_LARGE', async () => {
  const env = snapshotEnv([
    'DATABASE_URL',
    'WORKSPACE_MAX_FILE_SIZE_BYTES',
    'WORKSPACE_DISK_WARN_RATIO',
    'WORKSPACE_DISK_BLOCK_RATIO',
    'WORKSPACE_ROOT',
    'WORKSPACE_DEFAULT_QUOTA_BYTES',
  ]);
  delete process.env.DATABASE_URL;
  delete process.env.WORKSPACE_MAX_FILE_SIZE_BYTES;
  process.env.WORKSPACE_DISK_WARN_RATIO = '1';
  process.env.WORKSPACE_DISK_BLOCK_RATIO = '1';
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-max-file-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = String(50 * 1024 * 1024);
  const id = 'ffffffff-6666-4666-8666-666666666666';
  const auth = authContextFromUser(user(id));
  const service = new FileService({ getThreadById: async () => ({ id: 't', resourceId: id }) });
  try {
    await service.write(auth, 't', 'exact.bin', Buffer.alloc(10 * 1024 * 1024));
    await assert.rejects(
      () => service.write(auth, 't', 'over.bin', Buffer.alloc(10 * 1024 * 1024 + 1)),
      (error: unknown) => error instanceof FileServiceError && error.code === 'FILE_TOO_LARGE',
    );
  } finally {
    restoreEnv(env);
  }
});

test('overwrite write reserves only max(0, new - old) and shrinking releases the difference', async () => {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT', 'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-overwrite-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '50';
  try {
    const id = '10101010-1010-4101-8101-101010101010';
    const auth = authContextFromUser(user(id));
    const service = new FileService({ getThreadById: async () => ({ id: 't', resourceId: id }) });
    const quota = new WorkspaceQuota();
    await service.write(auth, 't', 'note.txt', Buffer.alloc(40));
    await service.write(auth, 't', 'note.txt', Buffer.alloc(45));
    assert.equal((await quota.usage(id)).usedBytes, 45);
    assert.equal((await quota.usage(id)).fileCount, 1);
    await service.write(auth, 't', 'note.txt', Buffer.alloc(10));
    assert.equal((await quota.usage(id)).usedBytes, 10);
    assert.equal((await quota.usage(id)).fileCount, 1);
  } finally {
    restoreEnv(env);
  }
});

test('overwriting a zero-byte file does not increment the file count', async () => {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT', 'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-zero-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '50';
  try {
    const id = '12121212-1212-4121-8121-121212121212';
    const auth = authContextFromUser(user(id));
    const service = new FileService({ getThreadById: async () => ({ id: 't', resourceId: id }) });
    const quota = new WorkspaceQuota();
    await service.write(auth, 't', 'empty.txt', Buffer.alloc(0));
    await service.write(auth, 't', 'empty.txt', Buffer.from('hello'));
    const usage = await quota.usage(id);
    assert.equal(usage.usedBytes, 5);
    assert.equal(usage.fileCount, 1);
  } finally {
    restoreEnv(env);
  }
});

test('reconcileUsage keeps reserved bytes that are not yet on disk', async () => {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '100';
  try {
    const quota = new WorkspaceQuota();
    const id = '14141414-1414-4141-8141-141414141414';
    await quota.reserve(id, 80, 1);
    await quota.reconcileUsage(id, 0, 0);
    assert.equal((await quota.usage(id)).usedBytes, 80);
    assert.equal((await quota.usage(id)).fileCount, 1);
    await assert.rejects(() => quota.reserve(id, 30, 1), QuotaExceededError);
  } finally {
    restoreEnv(env);
  }
});

test('reconcileForList replaces stale over-count when no in-flight reserve', async () => {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT', 'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-list-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '1000';
  try {
    const quota = new WorkspaceQuota();
    const id = '15151515-1515-4151-8151-151515151515';
    await quota.reserve(id, 400, 2);
    // Simulate crash after reserve: settle inflight without file on disk, leaving stale bytes.
    await quota.commit(id, 400, 2);
    assert.equal(quota.hasInflightReserve(id), false);
    assert.equal((await quota.usage(id)).usedBytes, 400);
    const usage = await quota.reconcileForList(id, 0, 0);
    assert.equal(usage.usedBytes, 0);
    assert.equal(usage.fileCount, 0);
  } finally {
    restoreEnv(env);
  }
});

test('reconcileForList keeps in-flight reserve (max-only) and does not wipe it', async () => {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '1000';
  try {
    const quota = new WorkspaceQuota();
    const id = '16161616-1616-4161-8161-161616161616';
    await quota.reserve(id, 300, 1);
    assert.equal(quota.hasInflightReserve(id), true);
    const usage = await quota.reconcileForList(id, 0, 0);
    assert.equal(usage.usedBytes, 300);
    assert.equal(usage.fileCount, 1);
    await quota.commit(id, 300, 1);
  } finally {
    restoreEnv(env);
  }
});

test('disk reconcile retains other uploads still reserved before they reach disk', async () => {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT', 'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-overlap-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '100';
  const id = '17171717-1717-4171-8171-171717171717';
  try {
    const quota = new WorkspaceQuota();
    await quota.reserve(id, 40, 1);
    await quota.reserve(id, 40, 1);
    const root = workspaceRoot(id);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'first.bin'), Buffer.alloc(40));
    await quota.commit(id, 40, 1);
    const usage = await quota.reconcileFromDisk(id);
    assert.equal(usage.usedBytes, 80);
    assert.equal(usage.fileCount, 2);
    await assert.rejects(() => quota.reserve(id, 30, 1), QuotaExceededError);
    await writeFile(join(root, 'second.bin'), Buffer.alloc(40));
    await quota.commit(id, 40, 1);
    assert.equal((await quota.reconcileFromDisk(id)).usedBytes, 80);
  } finally {
    restoreEnv(env);
  }
});

test('reconcileFromDisk recounts regular files and skips symlinks outside the user root', async () => {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT', 'WORKSPACE_DEFAULT_QUOTA_BYTES']);
  delete process.env.DATABASE_URL;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-reconcile-'));
  process.env.WORKSPACE_DEFAULT_QUOTA_BYTES = '1000';
  try {
    const id = '13131313-1313-4131-8131-131313131313';
    const quota = new WorkspaceQuota();
    await quota.reserve(id, 999, 9);
    await quota.commit(id, 999, 9);
    const root = workspaceRoot(id);
    await mkdir(join(root, 'uploads'), { recursive: true });
    await writeFile(join(root, 'uploads', 'a.txt'), Buffer.alloc(7));
    await writeFile(join(root, 'uploads', 'b.txt'), Buffer.alloc(11));
    const outside = join(process.env.WORKSPACE_ROOT!, 'outside.bin');
    await writeFile(outside, Buffer.alloc(400));
    await symlink(outside, join(root, 'uploads', 'link.bin'));
    const usage = await quota.reconcileFromDisk(id);
    assert.equal(usage.usedBytes, 18);
    assert.equal(usage.fileCount, 2);
    assert.equal((await quota.usage(id)).usedBytes, 18);
    assert.equal((await quota.usage(id)).fileCount, 2);
  } finally {
    restoreEnv(env);
  }
});

test('database concurrent reserves that together exceed quota only commit one',
  { skip: !DATABASE_URL }, async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  const { getPool } = await import('../src/mastra/auth/db');
  const { createUser } = await import('../src/mastra/auth/service');
  const email = `quota-${randomUUID()}@example.test`;
  const created = await createUser({
    email, displayName: 'Quota', password: 'correct horse battery staple', role: 'user',
  });
  const quota = new WorkspaceQuota();
  try {
    await getPool().query(
      `INSERT INTO app_workspaces (user_id, workspace_id, root_path, quota_bytes, used_bytes, file_count)
       VALUES ($1, $2, $3, 1000, 0, 0)`,
      [created.id, `ws_${created.id}`, `/tmp/quota-${created.id}`],
    );
    const attempts = await Promise.allSettled([
      quota.reserve(created.id, 600),
      quota.reserve(created.id, 600),
    ]);
    const ok = attempts.filter(item => item.status === 'fulfilled').length;
    const denied = attempts.filter(item => item.status === 'rejected').length;
    assert.equal(ok, 1);
    assert.equal(denied, 1);
    const row = await getPool().query(
      'SELECT used_bytes, file_count FROM app_workspaces WHERE user_id = $1',
      [created.id],
    );
    assert.equal(Number(row.rows[0].used_bytes), 600);
    assert.equal(Number(row.rows[0].file_count), 1);
    assert.equal((await quota.usage(created.id)).usedBytes, 600);
  } finally {
    await getPool().query('DELETE FROM app_users WHERE id = $1', [created.id]);
    if (DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = DATABASE_URL;
  }
});

test('database disk reconcile preserves a reservation made by another quota instance',
  { skip: !DATABASE_URL }, async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  const { getPool } = await import('../src/mastra/auth/db');
  const { createUser } = await import('../src/mastra/auth/service');
  const previousRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'quota-db-overlap-'));
  const created = await createUser({
    email: `quota-overlap-${randomUUID()}@example.test`, displayName: 'Quota',
    password: 'correct horse battery staple', role: 'user',
  });
  const first = new WorkspaceQuota();
  const second = new WorkspaceQuota();
  try {
    await getPool().query(
      `INSERT INTO app_workspaces (user_id, workspace_id, root_path, quota_bytes)
       VALUES ($1, $2, $3, 100)`,
      [created.id, `ws_${created.id}`, workspaceRoot(created.id)],
    );
    await first.reserve(created.id, 40, 1);
    await second.reserve(created.id, 40, 1);
    const root = workspaceRoot(created.id);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'first.bin'), Buffer.alloc(40));
    await first.commit(created.id, 40, 1);
    assert.equal((await first.reconcileFromDisk(created.id)).usedBytes, 80);
    const state = await getPool().query(
      'SELECT used_bytes, pending_bytes, pending_files FROM app_workspaces WHERE user_id = $1',
      [created.id],
    );
    assert.equal(Number(state.rows[0].used_bytes), 80);
    assert.equal(Number(state.rows[0].pending_bytes), 40);
    assert.equal(Number(state.rows[0].pending_files), 1);
    await assert.rejects(() => second.reserve(created.id, 30, 1), QuotaExceededError);
  } finally {
    await getPool().query('DELETE FROM app_users WHERE id = $1', [created.id]);
    if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previousRoot;
    if (DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = DATABASE_URL;
  }
});
