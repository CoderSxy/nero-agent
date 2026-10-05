import { WORKSPACE_TOOLS } from '@mastra/core/workspace';

export class FilePathError extends Error {
  readonly status = 400;
  constructor(message = '文件路径无效') {
    super(message);
    this.name = 'FilePathError';
  }
}

export function isUserFilesEnabled(): boolean {
  return process.env.USER_FILES_ENABLED === 'true';
}

export function maxFileSizeBytes(): number {
  return Number(process.env.WORKSPACE_MAX_FILE_SIZE_BYTES ?? 100 * 1024 * 1024);
}

export function relativeFilePath(input: string): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('\\') || input.startsWith('/')) {
    throw new FilePathError();
  }
  const segments = input.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new FilePathError();
  return segments.join('/');
}

const nativeFilesystemDisabled = Object.fromEntries(
  Object.values(WORKSPACE_TOOLS.FILESYSTEM).map(name => [name, { enabled: false as const }]),
);

export const disabledNativeFilesystemTools = {
  ...nativeFilesystemDisabled,
  [WORKSPACE_TOOLS.SEARCH.SEARCH]: { enabled: false as const },
  [WORKSPACE_TOOLS.SEARCH.INDEX]: { enabled: false as const },
};
