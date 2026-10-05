import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { disabledNativeFilesystemTools } from '../files/policy';

const disabledSandbox = Object.fromEntries(
  Object.values(WORKSPACE_TOOLS.SANDBOX).map(name => [name, { enabled: false as const }]),
);
const disabledComputer = Object.fromEntries(
  Object.values(WORKSPACE_TOOLS.COMPUTER).map(name => [name, { enabled: false as const }]),
);

export const disabledNativeSandboxTools = {
  ...disabledSandbox,
  ...disabledComputer,
};

export const disabledNativeWorkspaceTools = {
  ...disabledNativeFilesystemTools,
  ...disabledNativeSandboxTools,
};

export function nativeCommandToolNames(): string[] {
  return [...Object.values(WORKSPACE_TOOLS.SANDBOX), ...Object.values(WORKSPACE_TOOLS.COMPUTER)];
}
