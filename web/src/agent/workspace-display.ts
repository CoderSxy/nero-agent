import type { WorkspaceSource } from './workspace-files';

type FileEntry = { path: string; type: 'file' | 'directory' };
export type DisplayEntry<T extends FileEntry> = { entry: T; depth: number; ancestors: string[] };

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Hide the UUID directory used to keep uploads unique; retain real paths for actions. */
export function workspaceDisplayEntries<T extends FileEntry>(entries: T[], source: WorkspaceSource): DisplayEntry<T>[] {
  const children = new Map<string, T[]>();
  for (const entry of entries) {
    const parent = entry.path.split('/').slice(0, -1).join('/');
    const siblings = children.get(parent) ?? [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  const hidden = new Set(source === 'personal' ? entries
    .filter(entry => entry.type === 'directory')
    .filter(entry => {
      const parts = entry.path.split('/');
      if (parts.length !== 2 || parts[0] !== 'uploads' || !UPLOAD_ID.test(parts[1]!)) return false;
      const descendants = children.get(entry.path) ?? [];
      return descendants.length === 0 || (descendants.length === 1 && descendants[0]!.type === 'file');
    }).map(entry => entry.path) : []);

  return entries.filter(entry => !hidden.has(entry.path)).map(entry => {
    const parts = entry.path.split('/');
    const ancestors = parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'))
      .filter(path => !hidden.has(path));
    return { entry, depth: parts.length - 1 - (hidden.has(parts.slice(0, -1).join('/')) ? 1 : 0), ancestors };
  });
}
