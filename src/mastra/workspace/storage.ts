import type {
  FileContent,
  FileStat,
  ListOptions,
  RemoveOptions,
  WorkspaceFilesystem,
  WriteOptions,
} from '@mastra/core/workspace';

export type WorkspaceStorage = Pick<
  WorkspaceFilesystem,
  'readFile' | 'writeFile' | 'readdir' | 'stat' | 'deleteFile' | 'exists'
> & {
  remove(path: string, options?: RemoveOptions): Promise<void>;
};

export function workspaceStorageFrom(filesystem: WorkspaceFilesystem): WorkspaceStorage {
  return {
    readFile: (path, options) => filesystem.readFile(path, options),
    writeFile: (path, content: FileContent, options?: WriteOptions) => filesystem.writeFile(path, content, options),
    readdir: (path, options?: ListOptions) => filesystem.readdir(path, options),
    stat: (path) => filesystem.stat(path),
    deleteFile: (path, options) => filesystem.deleteFile(path, options),
    exists: (path) => filesystem.exists(path),
    async remove(path: string, options?: RemoveOptions) {
      const info: FileStat = await filesystem.stat(path);
      if (info.type === 'directory') await filesystem.rmdir(path, { recursive: true, ...options });
      else await filesystem.deleteFile(path, options);
    },
  };
}
