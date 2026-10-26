import type { AuthContext } from '../auth/auth-context';

export type SkillRuntimeNetwork = 'none' | 'server-tools' | 'public';

export type SkillDependency = { name: string; version?: string; module?: string };
export type SkillRuntimeDependencies = {
  python?: SkillDependency[];
  node?: SkillDependency[];
  commands?: SkillDependency[];
};

export type SkillRuntimeManifest = {
  schemaVersion: 1 | 2;
  runtimes: Array<'python3' | 'node' | 'bash'>;
  entrypoints: string[];
  requiredTools: string[];
  network: SkillRuntimeNetwork;
  runtimeVersions?: Partial<Record<'python3' | 'node' | 'bash', string>>;
  dependencies?: SkillRuntimeDependencies;
};

export type SkillResource = {
  path: string;
  bytes: Uint8Array;
  size: number;
  isText: boolean;
};

export type ValidatedSkillPackage = {
  /** Accepted canonical name; empty when import still requires explicit name acceptance. */
  canonicalName: string;
  sourceName: string;
  suggestedCanonicalName: string;
  requiresNameAcceptance: boolean;
  description: string;
  skillMd: string;
  resources: SkillResource[];
  runtimeManifest: SkillRuntimeManifest | null;
  warnings: string[];
};

export type SkillMdValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  metadata?: Record<string, unknown>;
  instructions?: string;
  sourceName?: string;
  suggestedCanonicalName?: string;
  requiresNameAcceptance?: boolean;
};

export type SkillImportPreview = {
  importId: string;
  tempRoot: string;
  expiresAt: Date;
  package: ValidatedSkillPackage;
  warnings: string[];
};

export type SkillPackageFile = {
  path: string;
  bytes: Uint8Array;
};

/**
 * Repository / API actor — always server AuthContext from trustedAuth.
 * Never accept client-forged roles from request body as the actor identity.
 */
export type SkillActor = AuthContext;

export type SkillVisibility = 'private' | 'global' | 'restricted';
export type SkillVersionState = 'draft' | 'published';
export type SkillGrantPermission = 'use' | 'edit' | 'publish';

/** Skill row DTO; revision is a decimal string to avoid JS bigint precision loss. */
export type SkillRecord = {
  id: string;
  canonicalName: string;
  ownerUserId: string;
  groupId: string | null;
  visibility: SkillVisibility;
  enabled: boolean;
  publishedVersion: number | null;
  revision: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillVersionRecord = {
  skillId: string;
  version: number;
  state: SkillVersionState;
  description: string;
  skillMd: string;
  manifestHash: string | null;
  runtimeManifest: SkillRuntimeManifest | null;
  createdBy: string;
  publishedBy: string | null;
  publishedAt: string | null;
  publishedRemark: string | null;
  revision: string;
  createdAt: string;
  updatedAt: string;
};

export type SkillFileInput = {
  path: string;
  blobHash: string;
  size: number;
  mimeType?: string | null;
  isText: boolean;
};

export type SkillPageQuery = {
  page: number;
  pageSize: number;
  q?: string;
  groupId?: string;
};

export type SkillListPage<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type CreateSkillDraftInput = {
  ownerUserId: string;
  canonicalName: string;
  description: string;
  skillMd: string;
  alias?: string | null;
  groupId?: string | null;
  runtimeManifest?: SkillRuntimeManifest | null;
  files?: SkillFileInput[];
  actorUserId?: string;
};

/** Create a new draft version on an existing skill (no draft may already exist). */
export type CreateWorkingDraftInput = {
  skillId: string;
  expectedRevision: string;
  actorUserId: string;
  description: string;
  skillMd: string;
  runtimeManifest?: SkillRuntimeManifest | null;
  files?: SkillFileInput[];
};

/** Atomic draft replace used by import commit and selective sync. */
export type ApplyDraftPackageInput = {
  skillId: string;
  expectedRevision: string;
  actorUserId: string;
  event: 'import' | 'sync';
  description?: string;
  skillMd?: string;
  /** undefined keeps the current runtime manifest; null clears it. */
  runtimeManifest?: SkillRuntimeManifest | null;
  /** Full resource snapshot for the draft (SKILL.md excluded). */
  files: SkillFileInput[];
  /** Rename unpublished drafts. Published skills reject a different name. */
  canonicalName?: string;
  /** undefined leaves aliases; null clears them; string replaces them. */
  alias?: string | null;
};

export type SkillSyncSessionKind = 'import' | 'sync';
export type SkillSyncSessionStatus = 'pending' | 'committed' | 'aborted';

export type SkillSyncSessionInput = {
  id: string;
  kind: SkillSyncSessionKind;
  skillId: string | null;
  baseRevision: string | null;
  version: number | null;
  actorUserId: string;
  payload: unknown;
  tempRoot: string;
  expiresAt: Date;
};

export type SkillSyncSessionRecord = {
  id: string;
  kind: SkillSyncSessionKind;
  skillId: string | null;
  baseRevision: string | null;
  version: number | null;
  actorUserId: string;
  payload: unknown;
  tempRoot: string;
  expiresAt: Date;
  status: SkillSyncSessionStatus;
};

export type UpdateSkillDraftInput = {
  skillId: string;
  expectedRevision: string;
  actorUserId: string;
  description?: string;
  skillMd?: string;
  runtimeManifest?: SkillRuntimeManifest | null;
  /** When provided, replaces all resource rows for the current draft (not SKILL.md). */
  files?: SkillFileInput[];
};

export type SkillGrantInput = {
  userId: string;
  permission: SkillGrantPermission;
};

export type UpdateSkillMetadataInput = {
  skillId: string;
  expectedRevision: string;
  actorUserId: string;
  visibility?: SkillVisibility;
  groupId?: string | null;
  enabled?: boolean;
  /** Soft-delete when true; omits leave deleted_at unchanged. */
  deleted?: boolean;
  grants?: SkillGrantInput[];
  audienceIds?: string[];
};

export type SkillFileRecord = {
  skillId: string;
  version: number;
  path: string;
  blobHash: string;
  size: number;
  mimeType: string | null;
  isText: boolean;
};

/** One immutable release file entry (paths POSIX, sorted for manifest hashing). */
export type SkillManifestEntry = {
  path: string;
  blobHash: string;
  size: number;
  isText: boolean;
  mimeType?: string | null;
};

export type SkillReleaseManifest = {
  skillId: string;
  version: number;
  skillMd: string;
  entries: SkillManifestEntry[];
};

export type PublishSkillInput = {
  skillId: string;
  version: number;
  expectedRevision: string;
  remark?: string | null;
};

/**
 * Public publish/rollback result for HTTP/API layers.
 * Never include host `releaseRoot` here — that path is internal-only.
 */
export type SkillPublishResult = {
  skill: SkillRecord;
  version: SkillVersionRecord;
  manifestHash: string;
};

export type RollbackSkillInput = {
  skillId: string;
  targetVersion: number;
  expectedRevision: string;
};

/** Derive a new draft from a published version by copying file references (not bytes). */
export type DeriveWorkingDraftInput = {
  skillId: string;
  expectedRevision: string;
  actorUserId: string;
  /** Defaults to current published_version. */
  fromVersion?: number;
  description?: string;
  skillMd?: string;
};

export type SkillPin = {
  skillId: string;
  name: string;
  version: number;
  manifestHash: string;
};

export type SkillExecutionContext = {
  serverExecutionId: string;
  auth: AuthContext;
  threadId: string;
  pins: Map<string, SkillPin>;
  /** Durable successful load events, distinct from discovery/search pins. */
  loadedSkillIds?: Set<string>;
};

/** Safe activation summary for stream chunks + assistant message metadata. */
export type SkillActivationEvent = {
  serverExecutionId: string;
  skillId: string;
  name: string;
  version?: number;
  manifestHash?: string;
  status: 'loaded' | 'failed';
  errorCode?: string;
};

export type SkillRunPinRecord = SkillPin & {
  instructionsLoaded?: boolean;
  serverExecutionId: string;
  userId: string;
  threadId: string;
  expiresAt: string;
};

export type SkillAvailability =
  | 'instructions-only'
  | 'ready'
  | 'missing-runtime'
  | 'missing-tools'
  | 'network-unavailable';

export type SkillStorageHealth = 'unknown' | 'healthy' | 'repairable' | 'unavailable' | 'checking';

export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  version: number;
  userInvocable: boolean;
  availability: SkillAvailability;
  storageHealth?: SkillStorageHealth;
};

export type SkillResult<T> =
  | { ok: true; skill: SkillPin; data: T }
  | { ok: false; code: string; message: string };

export type SkillResourceGroup = 'references' | 'scripts' | 'assets' | 'other';

export type SkillResourceSummary = {
  path: string;
  group: SkillResourceGroup;
  isText: boolean;
  size: number;
};

export type SkillActivation = {
  instructions: string;
  baseUri: string;
  description: string;
  resources: SkillResourceSummary[];
  hasMoreResources: boolean;
  availability: SkillAvailability;
};

export type SkillText = {
  path: string;
  text: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
  hasMore: boolean;
  nextStartLine: number | null;
};

export type SkillSearchHit = {
  pin: SkillPin;
  path: string;
  snippet: string;
  lineRange: { start: number; end: number };
  score: number;
};

export type SkillSearchPage = {
  hits: SkillSearchHit[];
  truncated: boolean;
};

/** Script execution result — never includes hostPath / releaseRoot / absolute cwd. */
export type SkillScriptOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  /** Paths relative to the current thread workspace directory. */
  artifactRelativePaths: string[];
};

export type SkillEventRecord = {
  id: string;
  skillId: string;
  version: number | null;
  actorUserId: string;
  event: string;
  serverExecutionId: string | null;
  result: string | null;
  errorCode: string | null;
  safeMetadata: Record<string, unknown> | null;
  createdAt: string;
};

export type SkillManageDetail = {
  grants: SkillGrantInput[];
  audienceIds: string[];
  skill: SkillRecord;
  draft: SkillVersionRecord | null;
  published: SkillVersionRecord | null;
  canEdit: boolean;
  canPublish: boolean;
  canManage: boolean;
};

export type SkillReadInput = {
  skillName: string;
  path: string;
  startLine?: number;
  endLine?: number;
};

export type SkillSearchInput = {
  query: string;
  skillNames?: string[];
  topK?: number;
};

export type CreateDraftServiceInput = {
  name: string;
  description: string;
  skillMd?: string;
  alias?: string | null;
  groupId?: string | null;
};

export type SaveDraftServiceInput = {
  skillId: string;
  expectedRevision: string;
  skillMd?: string;
  description?: string;
};

export type SaveFileServiceInput = {
  skillId: string;
  expectedRevision: string;
  path: string;
  bytes: Uint8Array;
  mimeType?: string | null;
};

export type SetMetadataServiceInput = {
  skillId: string;
  expectedRevision: string;
  visibility?: SkillVisibility;
  groupId?: string | null;
  grants?: SkillGrantInput[];
  audienceIds?: string[];
};

export type SkillManageListItem = SkillRecord & {
  description: string;
  canEdit: boolean;
  canPublish: boolean;
  canManage: boolean;
  storageHealth?: SkillStorageHealth;
  availability?: SkillAvailability;
};

export type SkillGroupRecord = {
  id: string;
  name: string;
  sort: number;
  createdAt: string;
  updatedAt: string;
};

export type SkillAudienceRecord = {
  id: string;
  name: string;
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type SkillUserPickerItem = {
  id: string;
  displayName: string;
};

export type SkillFileDownload = {
  bytes: Uint8Array;
  path: string;
  mimeType: string | null;
  isText: boolean;
};

export type SkillVersionSummary = {
  version: number;
  state: SkillVersionState;
  description: string;
  manifestHash: string | null;
  publishedAt: string | null;
  publishedRemark: string | null;
  createdAt: string;
  updatedAt: string;
  storageHealth?: SkillStorageHealth;
};

export type SetEnabledServiceInput = {
  skillId: string;
  expectedRevision: string;
  enabled: boolean;
};

export type DeleteSkillServiceInput = {
  skillId: string;
  expectedRevision: string;
};

export type DeleteDraftFileServiceInput = {
  skillId: string;
  expectedRevision: string;
  path: string;
};

export type DeleteVersionServiceInput = {
  skillId: string;
  version: number;
  expectedRevision: string;
};

export type CreateWorkingDraftServiceInput = {
  skillId: string;
  expectedRevision: string;
  fromVersion?: number;
};
