/** Web DTOs for agent-skills HTTP — mirror backend semantics without importing server modules. */

export type SkillVisibility = 'private' | 'global' | 'restricted';
export type SkillVersionState = 'draft' | 'published';
export type SkillGrantPermission = 'use' | 'edit' | 'publish';

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
  runtimeManifest: unknown | null;
  createdBy: string;
  publishedBy: string | null;
  publishedAt: string | null;
  publishedRemark: string | null;
  revision: string;
  createdAt: string;
  updatedAt: string;
};

export type SkillManageListItem = SkillRecord & {
  description: string;
  canEdit: boolean;
  canPublish: boolean;
  canManage: boolean;
  storageHealth?: SkillStorageHealth;
  availability?: SkillAvailability;
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

export type SkillFileRecord = {
  skillId: string;
  version: number;
  path: string;
  blobHash: string;
  size: number;
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

export type SkillGrantInput = {
  userId: string;
  permission: SkillGrantPermission;
};

export type SkillListPage<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type SkillPublishResult = {
  skill: SkillRecord;
  version: SkillVersionRecord;
  manifestHash: string;
};

export type SkillApiErrorBody = {
  error?: { code?: string; message?: string } | string;
};

export type SkillDiffKind = 'add' | 'modify' | 'delete' | 'unchanged';

export type SkillDiffEntry = {
  path: string;
  kind: SkillDiffKind;
  baseHash: string | null;
  incomingHash: string | null;
  selected: boolean;
};

export type SkillReferenceRenameRisk = {
  path: string;
  message: string;
};

export type SkillImportReport = {
  importId: string;
  expiresAt: string;
  sourceName: string;
  suggestedCanonicalName: string;
  requiresNameAcceptance: boolean;
  canonicalName: string;
  description: string;
  warnings: string[];
  referenceRenameRisks: SkillReferenceRenameRisk[];
  compatibility: string;
  files: Array<{ path: string; hash: string; size: number }>;
};

export type SkillSyncDiff = {
  syncId: string;
  skillId: string;
  baseRevision: string;
  draftVersion: number;
  expiresAt: string;
  entries: SkillDiffEntry[];
};

export type SkillAvailability =
  | 'instructions-only'
  | 'ready'
  | 'missing-runtime'
  | 'missing-tools'
  | 'network-unavailable';

export type SkillStorageHealth = 'unknown' | 'healthy' | 'repairable' | 'unavailable' | 'checking';

export type ShortcutFieldType = 'text' | 'textarea' | 'select' | 'number' | 'boolean';

export type ShortcutField = {
  key: string;
  label: string;
  type: ShortcutFieldType;
  required: boolean;
  min?: number;
  max?: number;
  options?: string[];
};

export type ShortcutPrompt = {
  label: string;
  template: string;
};

export type SkillShortcutRecord = {
  id: string;
  skillId: string;
  label: string;
  sort: number;
  enabled: boolean;
  fields: ShortcutField[];
  prompts: ShortcutPrompt[];
  revision: string;
};

export type SkillShortcutAvailable = SkillShortcutRecord & {
  skillName: string;
};

/** Runtime catalog item from GET /agent-skills/available. */
export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  version: number;
  userInvocable: boolean;
  availability: SkillAvailability;
  storageHealth?: SkillStorageHealth;
};
