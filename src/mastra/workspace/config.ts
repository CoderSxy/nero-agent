export function isWorkspaceResolverEnabled(): boolean {
  return process.env.WORKSPACE_RESOLVER_ENABLED === 'true';
}

export function isSandboxCommandsEnabled(): boolean {
  return process.env.SANDBOX_COMMANDS_ENABLED === 'true';
}

export function sandboxCommandTimeoutMs(): number {
  return Number(process.env.SANDBOX_COMMAND_TIMEOUT_MS ?? 120_000);
}

export function sandboxMaxConcurrent(): number {
  const value = Number(process.env.SANDBOX_MAX_CONCURRENT ?? 2);
  if (!Number.isInteger(value) || value < 1) throw new Error('SANDBOX_MAX_CONCURRENT must be a positive integer');
  return value;
}

export function defaultQuotaBytes(): number {
  return Number(process.env.WORKSPACE_DEFAULT_QUOTA_BYTES ?? 500 * 1024 * 1024);
}

export const DEFAULT_QUOTA_BYTES = defaultQuotaBytes();

export function maxWorkspaceFiles(): number {
  return Number(process.env.WORKSPACE_MAX_FILES ?? 5000);
}

export function isSandboxFileWriteEnabled(): boolean {
  return process.env.SANDBOX_FILE_WRITE_ENABLED === 'true';
}

export function diskWarnRatio(): number {
  return Number(process.env.WORKSPACE_DISK_WARN_RATIO ?? 0.8);
}

export function diskBlockRatio(): number {
  return Number(process.env.WORKSPACE_DISK_BLOCK_RATIO ?? 0.9);
}
