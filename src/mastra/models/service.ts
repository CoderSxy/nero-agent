import type { AuthUser } from '../auth/service';
import { decryptApiKey, encryptApiKey, keyHint } from './crypto';
import { GATEWAY_BASE_URL } from './gateway-sync';
import { assertAllowedEndpoint, normalizeModelEndpoint } from './endpoint-policy';
import {
  clearPublicDefault,
  deleteRecord,
  findEnabledPublicByProviderModel,
  findRecord,
  insertRecord,
  listAllPublic,
  listEnabledPublic,
  listPrivateForUser,
  lockPublicDefault,
  updateRecord,
  withTransaction,
  type ModelColumns,
  type ModelRecord,
} from './repository';
import {
  ModelCatalogError,
  parseModelRef,
  toModelRef,
  type ApiMode,
  type ModelInput,
  type ModelRef,
  type ModelScope,
  type SafeModel,
} from './types';

export type { ModelRecord } from './repository';

const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:/-]+$/;
const API_MODES: readonly ApiMode[] = ['chat', 'responses'];
const MAX_API_KEY_LENGTH = 4096;
const INPUT_KEYS = new Set<keyof ModelInput>([
  'displayName', 'providerId', 'modelId', 'baseUrl', 'apiMode', 'apiKey', 'enabled',
  'supportsVision', 'isDefault',
]);

function isAdmin(user: AuthUser): boolean {
  return Array.isArray(user.roles) && user.roles.includes('admin');
}

function assertScope(scope: unknown): asserts scope is ModelScope {
  if (scope !== 'public' && scope !== 'private') {
    throw new ModelCatalogError('invalid_input', 'Model scope is invalid');
  }
}

function assertManageable(scope: ModelScope, user: AuthUser): void {
  if (scope === 'public' && !isAdmin(user)) {
    throw new ModelCatalogError('forbidden', 'Administrator role is required for public models');
  }
}

function recordId(scope: ModelScope, id: string): string {
  const parsed = parseModelRef(`${scope}:${id}`);
  if (!parsed) throw new ModelCatalogError('not_found', 'Model was not found');
  return parsed.id;
}

function ownerFor(scope: ModelScope, user: AuthUser): string | null {
  return scope === 'private' ? user.id : null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ModelCatalogError('invalid_input', `${field} must be a string`);
  }
  return value.trim();
}

function validateDisplayName(value: unknown): string {
  const name = requireString(value, 'displayName');
  if (name.length < 1 || name.length > 100) {
    throw new ModelCatalogError('invalid_input', 'displayName must be 1 to 100 characters');
  }
  return name;
}

function validateProviderId(value: unknown): string {
  const providerId = requireString(value, 'providerId');
  if (providerId.length < 1 || providerId.length > 100 || !PROVIDER_ID_PATTERN.test(providerId)) {
    throw new ModelCatalogError('invalid_input', 'providerId may contain only letters, digits, dots, underscores and hyphens');
  }
  return providerId;
}

function validateModelId(value: unknown): string {
  const modelId = requireString(value, 'modelId');
  if (modelId.length < 1 || modelId.length > 200 || !MODEL_ID_PATTERN.test(modelId)) {
    throw new ModelCatalogError('invalid_input', 'modelId is invalid');
  }
  return modelId;
}

function validateApiMode(value: unknown): ApiMode {
  if (typeof value !== 'string' || !API_MODES.includes(value as ApiMode)) {
    throw new ModelCatalogError('invalid_input', 'apiMode must be chat or responses');
  }
  return value as ApiMode;
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ModelCatalogError('invalid_input', `${field} must be a boolean`);
  }
  return value;
}

async function validateBaseUrl(value: unknown): Promise<string> {
  const url = normalizeModelEndpoint(requireString(value, 'baseUrl'));
  await assertAllowedEndpoint(url);
  return `${url.origin}${url.pathname === '/' ? '' : url.pathname}${url.search}`;
}

function encryptNewKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ModelCatalogError('invalid_input', 'apiKey must be a string');
  }
  const key = value.trim();
  if (!key) throw new ModelCatalogError('invalid_input', 'apiKey must not be empty');
  if (key.length > MAX_API_KEY_LENGTH) {
    throw new ModelCatalogError('invalid_input', 'apiKey is too long');
  }
  return encryptApiKey(key);
}

function assertKnownKeys(input: object): void {
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key as keyof ModelInput)) {
      throw new ModelCatalogError('invalid_input', `Unknown field: ${key}`);
    }
  }
}

function hintFor(ciphertext: string): string | null {
  try {
    return keyHint(decryptApiKey(ciphertext));
  } catch {
    return null;
  }
}

export function effectiveModelSupportsVision(
  record: Pick<ModelRecord, 'baseUrl' | 'supportsVision' | 'catalogMetadata'>,
): boolean {
  if (!record.supportsVision) return false;
  if (record.baseUrl !== GATEWAY_BASE_URL) return true;
  const metadata = record.catalogMetadata;
  return metadata?.modality === 'multimodal'
    && metadata.imageSupport === true
    && metadata.imageInputConflict !== true;
}

function toSafeModel(record: ModelRecord): SafeModel {
  const safe: SafeModel = {
    ref: toModelRef(record.scope, record.id),
    scope: record.scope,
    displayName: record.displayName,
    providerId: record.providerId,
    modelId: record.modelId,
    baseUrl: record.baseUrl,
    apiMode: record.apiMode,
    enabled: record.enabled,
    hasApiKey: record.apiKeyCiphertext.length > 0,
    keyHint: record.apiKeyCiphertext ? hintFor(record.apiKeyCiphertext) : null,
    supportsVision: effectiveModelSupportsVision(record),
    catalogMetadata: record.catalogMetadata,
  };
  if (record.scope === 'public') safe.isDefault = record.isDefault;
  return safe;
}

export async function listSelectableModels(user: AuthUser): Promise<SafeModel[]> {
  const [publicModels, privateModels] = await Promise.all([
    listEnabledPublic(),
    listPrivateForUser(user.id, { enabledOnly: true }),
  ]);
  return [...publicModels, ...privateModels].map(toSafeModel);
}

export async function listManagedModels(scope: ModelScope, user: AuthUser): Promise<SafeModel[]> {
  assertScope(scope);
  assertManageable(scope, user);
  const records =
    scope === 'public' ? await listAllPublic() : await listPrivateForUser(user.id, { enabledOnly: false });
  return records.map(toSafeModel);
}

export async function createModel(scope: ModelScope, user: AuthUser, input: ModelInput): Promise<SafeModel> {
  assertScope(scope);
  assertManageable(scope, user);
  if (!input || typeof input !== 'object') {
    throw new ModelCatalogError('invalid_input', 'Model input is required');
  }
  assertKnownKeys(input);

  const enabled = input.enabled === undefined ? true : validateBoolean(input.enabled, 'enabled');
  const supportsVision = input.supportsVision === undefined
    ? false
    : validateBoolean(input.supportsVision, 'supportsVision');
  const isDefault = input.isDefault === undefined ? false : validateBoolean(input.isDefault, 'isDefault');
  if (isDefault && scope !== 'public') {
    throw new ModelCatalogError('invalid_input', 'Only public models can be the default');
  }
  if (isDefault && !enabled) {
    throw new ModelCatalogError('invalid_input', 'A default model must be enabled');
  }

  const columns: ModelColumns = {
    displayName: validateDisplayName(input.displayName),
    providerId: validateProviderId(input.providerId),
    modelId: validateModelId(input.modelId),
    baseUrl: await validateBaseUrl(input.baseUrl),
    apiMode: input.apiMode === undefined ? 'chat' : validateApiMode(input.apiMode),
    apiKeyCiphertext: encryptNewKey(input.apiKey),
    enabled,
    supportsVision,
    isDefault,
  };

  if (scope === 'public' && isDefault) {
    return toSafeModel(
      await withTransaction(async (client) => {
        await lockPublicDefault(client);
        await clearPublicDefault(client);
        return insertRecord('public', null, columns, client);
      }),
    );
  }
  return toSafeModel(await insertRecord(scope, ownerFor(scope, user), columns));
}

async function buildChanges(patch: Partial<ModelInput>, scope: ModelScope): Promise<Partial<ModelColumns>> {
  if (!patch || typeof patch !== 'object') {
    throw new ModelCatalogError('invalid_input', 'Model patch is required');
  }
  assertKnownKeys(patch);
  if (scope === 'private' && patch.isDefault !== undefined) {
    throw new ModelCatalogError('invalid_input', 'Only public models can be the default');
  }

  const changes: Partial<ModelColumns> = {};
  if (patch.displayName !== undefined) changes.displayName = validateDisplayName(patch.displayName);
  if (patch.providerId !== undefined) changes.providerId = validateProviderId(patch.providerId);
  if (patch.modelId !== undefined) changes.modelId = validateModelId(patch.modelId);
  if (patch.baseUrl !== undefined) changes.baseUrl = await validateBaseUrl(patch.baseUrl);
  if (patch.apiMode !== undefined) changes.apiMode = validateApiMode(patch.apiMode);
  if (patch.enabled !== undefined) changes.enabled = validateBoolean(patch.enabled, 'enabled');
  if (patch.supportsVision !== undefined) {
    changes.supportsVision = validateBoolean(patch.supportsVision, 'supportsVision');
  }
  if (patch.isDefault !== undefined) changes.isDefault = validateBoolean(patch.isDefault, 'isDefault');
  if (patch.apiKey !== undefined) changes.apiKeyCiphertext = encryptNewKey(patch.apiKey);
  return changes;
}

export async function updateModel(
  scope: ModelScope,
  id: string,
  user: AuthUser,
  patch: Partial<ModelInput>,
): Promise<SafeModel> {
  assertScope(scope);
  assertManageable(scope, user);
  const targetId = recordId(scope, id);
  const changes = await buildChanges(patch, scope);
  const owner = ownerFor(scope, user);

  const updated = await withTransaction(async (client) => {
    if (scope === 'public') await lockPublicDefault(client);
    const existing = await findRecord(scope, targetId, owner, client, true);
    if (!existing) throw new ModelCatalogError('not_found', 'Model was not found');

    if (scope === 'public') {
      const enabledAfter = changes.enabled ?? existing.enabled;
      if (changes.isDefault === true && !enabledAfter) {
        throw new ModelCatalogError('invalid_input', 'A default model must be enabled');
      }
      if (!enabledAfter) changes.isDefault = false;
      if (changes.isDefault === true) await clearPublicDefault(client, targetId);
    }

    const result = await updateRecord(scope, targetId, owner, changes, client);
    if (!result) throw new ModelCatalogError('not_found', 'Model was not found');
    return result;
  });
  return toSafeModel(updated);
}

export async function deleteModel(scope: ModelScope, id: string, user: AuthUser): Promise<void> {
  assertScope(scope);
  assertManageable(scope, user);
  const targetId = recordId(scope, id);
  const removed = await deleteRecord(scope, targetId, ownerFor(scope, user));
  if (!removed) throw new ModelCatalogError('not_found', 'Model was not found');
}

export async function findAuthorizedModel(ref: ModelRef, user: AuthUser): Promise<ModelRecord> {
  const parsed = parseModelRef(ref);
  if (!parsed) throw new ModelCatalogError('invalid_input', 'Model reference is invalid');
  const record = await findRecord(parsed.scope, parsed.id, ownerFor(parsed.scope, user));
  if (!record) throw new ModelCatalogError('not_found', 'Model was not found');
  if (!record.enabled) throw new ModelCatalogError('disabled', 'Model is disabled');
  if (!record.apiKeyCiphertext) throw new ModelCatalogError('missing_key', 'Model has no API key configured');
  return record;
}

export async function matchLegacyPublicModel(value: string): Promise<ModelRef | null> {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return null;
  const providerId = value.slice(0, separator);
  const modelId = value.slice(separator + 1);
  if (!PROVIDER_ID_PATTERN.test(providerId) || !MODEL_ID_PATTERN.test(modelId)) return null;

  const matches = await findEnabledPublicByProviderModel(providerId, modelId);
  return matches.length === 1 ? toModelRef('public', matches[0].id) : null;
}
