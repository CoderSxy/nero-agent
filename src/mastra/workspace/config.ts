export function isWorkspaceResolverEnabled(): boolean {
  return process.env.WORKSPACE_RESOLVER_ENABLED === 'true';
}

export const DEFAULT_QUOTA_BYTES = Number(process.env.WORKSPACE_DEFAULT_QUOTA_BYTES ?? 500 * 1024 * 1024);
