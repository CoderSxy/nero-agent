export function isWorkspaceResolverEnabled(): boolean {
  return process.env.WORKSPACE_RESOLVER_ENABLED === 'true';
}

export function isSandboxCommandsEnabled(): boolean {
  return process.env.SANDBOX_COMMANDS_ENABLED === 'true';
}

export function sandboxCommandTimeoutMs(): number {
  return Number(process.env.SANDBOX_COMMAND_TIMEOUT_MS ?? 120_000);
}

export const DEFAULT_QUOTA_BYTES = Number(process.env.WORKSPACE_DEFAULT_QUOTA_BYTES ?? 500 * 1024 * 1024);
