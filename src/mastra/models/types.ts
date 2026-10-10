export type ModelScope = 'public' | 'private';

export type ModelRef = `public:${string}` | `private:${string}`;

export type ApiMode = 'chat' | 'responses';

export type CatalogMetadata = {
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  creditMultiplier?: number;
  creditLabel?: string;
  modality?: 'text' | 'multimodal' | 'unverified' | 'router';
  providerName?: string;
  inferenceOnly?: boolean;
  description?: string;
  imageInputConflict?: boolean;
  imageSupport?: boolean | null;
};

export type SafeModel = {
  ref: ModelRef;
  scope: ModelScope;
  displayName: string;
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiMode: ApiMode;
  enabled: boolean;
  hasApiKey: boolean;
  keyHint: string | null;
  supportsVision: boolean;
  catalogMetadata?: CatalogMetadata | null;
  isDefault?: boolean;
};

export type ModelInput = {
  displayName: string;
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiMode?: ApiMode;
  apiKey?: string;
  enabled?: boolean;
  supportsVision?: boolean;
  isDefault?: boolean;
};

export type ModelCatalogErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'forbidden'
  | 'disabled'
  | 'missing_key'
  | 'no_public_models'
  | 'legacy_ambiguous';

export class ModelCatalogError extends Error {
  readonly code: ModelCatalogErrorCode;

  constructor(code: ModelCatalogErrorCode, message: string) {
    super(message);
    this.name = 'ModelCatalogError';
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseModelRef(value: unknown): { scope: ModelScope; id: string } | null {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const scope = value.slice(0, separator);
  if (scope !== 'public' && scope !== 'private') return null;
  const id = value.slice(separator + 1);
  if (!UUID_PATTERN.test(id)) return null;
  return { scope, id };
}

export function toModelRef(scope: ModelScope, id: string): ModelRef {
  return `${scope}:${id}`;
}
