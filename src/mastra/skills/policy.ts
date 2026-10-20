import type { SkillActor, SkillGrantPermission, SkillRecord, SkillVisibility } from './types';

export type SkillPermissionSkill = {
  id: string;
  ownerUserId: string;
  visibility: SkillVisibility;
  enabled: boolean;
  publishedVersion: number | null;
  deletedAt: string | null;
};

export type SkillPermissionSnapshot = {
  skill: SkillPermissionSkill;
  grants: SkillGrantPermission[];
  audienceUse: boolean;
  /** When false, actor is inactive/disabled — all capabilities denied. Default true. */
  actorActive?: boolean;
};

export type SkillCapabilities = {
  canUse: boolean;
  canViewDraft: boolean;
  canEdit: boolean;
  canPublish: boolean;
  /** Enable/disable, soft-delete, visibility/grants (owner or admin). */
  canManage: boolean;
  /** Only admin may set visibility=global. */
  canSetGlobal: boolean;
};

export type SkillPolicyErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'SKILL_UNAVAILABLE'
  | 'ACTOR_INACTIVE';

export class SkillPolicyError extends Error {
  readonly code: SkillPolicyErrorCode;
  readonly status: number;

  constructor(code: SkillPolicyErrorCode, message: string, status = 403) {
    super(message);
    this.name = 'SkillPolicyError';
    this.code = code;
    this.status = status;
  }
}

function isAdmin(actor: SkillActor): boolean {
  return actor.roles.includes('admin');
}

function isOwner(actor: SkillActor, skill: SkillPermissionSkill): boolean {
  return actor.userId === skill.ownerUserId;
}

function hasGrant(grants: SkillGrantPermission[], permission: SkillGrantPermission): boolean {
  return grants.includes(permission);
}

/**
 * Spec §6 permission matrix.
 * Admin manage rights do NOT imply runtime use.
 * edit does NOT imply publish; use cannot view drafts.
 */
export function evaluateSkillPermissions(
  actor: SkillActor,
  snapshot: SkillPermissionSnapshot,
): SkillCapabilities {
  const denied: SkillCapabilities = {
    canUse: false,
    canViewDraft: false,
    canEdit: false,
    canPublish: false,
    canManage: false,
    canSetGlobal: false,
  };

  if (snapshot.actorActive === false) {
    return denied;
  }
  if (!actor.userId || !Array.isArray(actor.roles)) {
    return denied;
  }

  const { skill, grants, audienceUse } = snapshot;
  if (skill.deletedAt) {
    return denied;
  }

  const admin = isAdmin(actor);
  const owner = isOwner(actor, skill);
  const editGrant = hasGrant(grants, 'edit');
  const publishGrant = hasGrant(grants, 'publish');
  const useGrant = hasGrant(grants, 'use');

  const canManage = owner || admin;
  const canEdit = owner || admin || editGrant;
  const canPublish = owner || admin || publishGrant;
  const canViewDraft = owner || admin || editGrant || publishGrant;
  const canSetGlobal = admin;

  const publishedReady = skill.enabled && skill.publishedVersion != null;
  const useEntitled =
    owner
    || skill.visibility === 'global'
    || useGrant
    || audienceUse;
  const canUse = publishedReady && useEntitled;

  return {
    canUse,
    canViewDraft,
    canEdit,
    canPublish,
    canManage,
    canSetGlobal,
  };
}

export function skillRecordToPermissionSkill(
  skill: Pick<
    SkillRecord,
    'id' | 'ownerUserId' | 'visibility' | 'enabled' | 'publishedVersion' | 'deletedAt'
  >,
): SkillPermissionSkill {
  return {
    id: skill.id,
    ownerUserId: skill.ownerUserId,
    visibility: skill.visibility,
    enabled: skill.enabled,
    publishedVersion: skill.publishedVersion,
    deletedAt: skill.deletedAt,
  };
}

export function assertCanEdit(caps: SkillCapabilities): void {
  if (!caps.canEdit) {
    throw new SkillPolicyError('FORBIDDEN', 'Skill edit permission required');
  }
}

export function assertCanPublish(caps: SkillCapabilities): void {
  if (!caps.canPublish) {
    throw new SkillPolicyError('FORBIDDEN', 'Skill publish permission required');
  }
}

export function assertCanManage(caps: SkillCapabilities): void {
  if (!caps.canManage) {
    throw new SkillPolicyError('FORBIDDEN', 'Skill manage permission required');
  }
}

export function assertCanViewDraft(caps: SkillCapabilities): void {
  if (!caps.canViewDraft) {
    throw new SkillPolicyError('FORBIDDEN', 'Skill draft is not visible');
  }
}

/** Runtime visibility failures share one code — do not leak skill names. */
export function unavailable(message = 'Skill is unavailable'): SkillPolicyError {
  return new SkillPolicyError('SKILL_UNAVAILABLE', message, 404);
}

export function assertCanUse(caps: SkillCapabilities): void {
  if (!caps.canUse) {
    throw unavailable();
  }
}
