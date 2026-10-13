import type { RequestContext } from '@mastra/core/request-context';
import { isFinanceCategory, type FinanceCategory } from './catalog';

export const FINANCE_CATEGORY_METADATA_KEY = 'neroAgentFinanceCategory';
const verifiedScopes = new WeakMap<RequestContext, FinanceCategory | null>();

export function readFinanceCategory(metadata: unknown): FinanceCategory | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[FINANCE_CATEGORY_METADATA_KEY];
  return isFinanceCategory(value) ? value : null;
}

export function setVerifiedFinanceCategory(context: RequestContext, category: FinanceCategory | null): void {
  verifiedScopes.set(context, category);
}

export function trustedFinanceCategory(context: RequestContext | undefined): FinanceCategory | null {
  return context ? verifiedScopes.get(context) ?? null : null;
}

export function isFinanceEnabled(): boolean {
  return process.env.FINANCE_TOOL_ENABLED === 'true' && Boolean(process.env.AKTOOLS_BASE_URL);
}
