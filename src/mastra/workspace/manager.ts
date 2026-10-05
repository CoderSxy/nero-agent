import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthContext } from '../auth/auth-context';
import { DEFAULT_QUOTA_BYTES } from './config';
import { assertContained, workspaceBase, workspaceRoot } from './path';

export { threadRoot, workspaceRoot } from './path';

const WORKSPACE_SUBDIRS = ['shared', 'uploads', 'projects', 'threads'];

export async function ensureUserWorkspace(auth: AuthContext): Promise<string> {
  const base = workspaceBase();
  const root = workspaceRoot(auth.userId);
  await mkdir(base, { recursive: true });
  await mkdirContained(join(base, 'users'), base);
  await mkdirContained(join(base, 'users', auth.userId), base);
  await mkdirContained(root, base);
  for (const dir of WORKSPACE_SUBDIRS) {
    await mkdirContained(join(root, dir), base);
  }
  await recordWorkspace(auth, root);
  return root;
}

async function mkdirContained(path: string, base: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink()) throw new Error('Workspace path is a symlink');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(path, { recursive: true });
  const real = await realpath(path);
  const realBase = await realpath(base);
  assertContained(realBase, real);
}

async function recordWorkspace(auth: AuthContext, root: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const { getPool } = await import('../auth/db');
  await getPool().query(
    `INSERT INTO app_workspaces (user_id, workspace_id, root_path, quota_bytes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET root_path = EXCLUDED.root_path, updated_at = now()`,
    [auth.userId, `ws_${auth.userId}`, root, DEFAULT_QUOTA_BYTES],
  );
}
