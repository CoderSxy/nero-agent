import { withSkillStorageReadLock } from './storage-lock';
import type { Pool } from 'pg';
import type { BlobStore } from './blob-store';
import { SkillRepositoryError } from './errors';
import {
  assertCanPublish,
  evaluateSkillPermissions,
  SkillPolicyError,
  skillRecordToPermissionSkill,
} from './policy';
import type { ReleaseStore } from './release-store';
import type { SkillRepository } from './repository';
import type {
  DeriveWorkingDraftInput,
  PublishSkillInput,
  RollbackSkillInput,
  SkillActor,
  SkillFileInput,
  SkillManifestEntry,
  SkillPublishResult,
  SkillRecord,
  SkillReleaseManifest,
  SkillVersionRecord,
} from './types';
import { SKILL_LIMITS, validateSkillMd } from './validation';
import { parseRuntimeManifest } from './package';
import { validateSkillVersionResources } from './repository';
import { getActiveUserById } from '../auth/service';

export type SkillVersionServiceHooks = {
  /** After immutable release is on disk, before DB pointer transaction. */
  afterReleaseBeforeDb?: (info: {
    skillId: string;
    version: number;
    manifestHash: string;
    releaseRoot: string;
  }) => Promise<void>;
};

export type SkillVersionServiceDeps = {
  repository: SkillRepository;
  blobStore: BlobStore;
  releaseStore: ReleaseStore;
  /** Reserved for future pin lookups; publish path uses repository transactions. */
  pool?: Pool;
  hooks?: SkillVersionServiceHooks;
};

export type SkillVersionService = {
  deps: SkillVersionServiceDeps;
};

export type DeleteSkillVersionArgs = {
  skillId: string;
  version: number;
  expectedRevision: string;
  /** Task 5 will pass real active-pin detection; default false. */
  hasActivePin?: boolean;
};

export function createSkillVersionService(deps: SkillVersionServiceDeps): SkillVersionService {
  return { deps };
}

function buildManifest(
  skillId: string,
  version: number,
  skillMd: string,
  files: Array<{ path: string; blobHash: string; size: number; isText: boolean; mimeType?: string | null }>,
): SkillReleaseManifest {
  const entries: SkillManifestEntry[] = files.map((f) => ({
    path: f.path,
    blobHash: f.blobHash,
    size: f.size,
    isText: f.isText,
    mimeType: f.mimeType ?? null,
  }));
  return { skillId, version, skillMd, entries };
}

function validateRemark(remark: string | null | undefined): string | null {
  if (remark == null || remark === '') return null;
  if (remark.length > SKILL_LIMITS.PUBLISH_REMARK_MAX) {
    throw new SkillRepositoryError(
      'INVALID_INPUT',
      `remark exceeds ${SKILL_LIMITS.PUBLISH_REMARK_MAX} characters`,
      400,
    );
  }
  return remark;
}

/**
 * Publish a draft version: materialize immutable release, then CAS-update pointer.
 * First publish keeps enabled=false; already-enabled skills stay enabled.
 * Mid-failure leaves the previous publish pointer unchanged.
 *
 * Returns SkillPublishResult — never includes host releaseRoot.
 */
async function assertPublishAuthorized(
  repository: SkillRepository,
  actor: SkillActor,
  skillId: string,
): Promise<void> {
  const active = (await getActiveUserById(actor.userId)) != null;
  if (!active) {
    throw new SkillPolicyError('ACTOR_INACTIVE', 'Actor is not active', 403);
  }
  const access = await repository.getAccessSnapshot(skillId, actor.userId);
  if (!access) {
    throw new SkillPolicyError('FORBIDDEN', 'Skill not found', 404);
  }
  const caps = evaluateSkillPermissions(actor, {
    skill: skillRecordToPermissionSkill(access.skill),
    grants: access.grants,
    audienceUse: access.audienceUse,
    actorActive: active,
  });
  assertCanPublish(caps);
}

async function publishSkillUnlocked(
  service: SkillVersionService,
  actor: SkillActor,
  input: PublishSkillInput,
): Promise<SkillPublishResult> {
  const { repository, blobStore, releaseStore, hooks } = service.deps;
  const remark = validateRemark(input.remark);

  await assertPublishAuthorized(repository, actor, input.skillId);

  const skill = await repository.getSkill(input.skillId);
  if (!skill) {
    throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Skill not found', 404);
  }
  if (skill.revision !== String(input.expectedRevision)) {
    throw new SkillRepositoryError(
      'REVISION_CONFLICT',
      `expectedRevision ${input.expectedRevision} does not match current ${skill.revision}`,
    );
  }

  const version = await repository.getVersion(input.skillId, input.version);
  if (!version) {
    throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Version not found', 404);
  }
  if (version.state !== 'draft') {
    throw new SkillRepositoryError(
      'VERSION_NOT_DRAFT',
      `Version ${input.version} is not a draft`,
    );
  }

  const files = await repository.listFiles(input.skillId, input.version);
  validateSkillVersionResources(version.skillMd, files);
  const validatedMd = validateSkillMd(version.skillMd, skill.canonicalName);
  if (!validatedMd.valid) {
    throw new SkillRepositoryError('VERSION_INCOMPLETE', validatedMd.errors.join('; '), 422);
  }
  // The published files are the source of truth, not a stale draft JSONB cache.
  const runtimeFile = files.find(file => file.path === 'skill-runtime.json');
  let runtimeManifest = null;
  if (runtimeFile) {
    if (runtimeFile.size > SKILL_LIMITS.JSON_MAX_BYTES) {
      throw new SkillRepositoryError('VERSION_INCOMPLETE', 'skill-runtime.json exceeds the JSON limit', 422);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of await blobStore.openVerified(runtimeFile.blobHash)) chunks.push(Buffer.from(chunk));
    runtimeManifest = parseRuntimeManifest(Buffer.concat(chunks));
    for (const path of runtimeManifest.entrypoints) {
      if (!files.some(file => file.path === path)) {
        throw new SkillRepositoryError('VERSION_INCOMPLETE', `Missing runtime entrypoint: ${path}`, 422);
      }
    }
  }
  for (const file of files) {
    const ok = await blobStore.exists(file.blobHash);
    if (!ok) {
      throw new SkillRepositoryError(
        'VERSION_INCOMPLETE',
        `Missing blob for ${file.path}`,
        422,
      );
    }
  }

  const manifest = buildManifest(input.skillId, input.version, version.skillMd, files);
  const materialized = await releaseStore.materialize(input.skillId, input.version, manifest);

  if (hooks?.afterReleaseBeforeDb) {
    await hooks.afterReleaseBeforeDb({
      skillId: input.skillId,
      version: input.version,
      manifestHash: materialized.manifestHash,
      releaseRoot: materialized.releaseRoot,
    });
  }

  // Pointer update under row lock + expectedRevision. Failure → old pointer retained.
  const applied = await repository.applyPublishPointer({
    skillId: input.skillId,
    version: input.version,
    expectedRevision: input.expectedRevision,
    actorUserId: actor.userId,
    manifestHash: materialized.manifestHash,
    runtimeManifest,
    remark,
  });

  // Strip any accidental host path — DTO contract.
  const result: SkillPublishResult = {
    skill: applied.skill,
    version: applied.version,
    manifestHash: materialized.manifestHash,
  };
  return result;
}

/**
 * Point published_version at a previously published, file-complete release.
 * Verifies release on disk; fail closed if missing/corrupt.
 */
async function rollbackSkillUnlocked(
  service: SkillVersionService,
  actor: SkillActor,
  input: RollbackSkillInput,
): Promise<SkillPublishResult> {
  const { repository, releaseStore } = service.deps;

  await assertPublishAuthorized(repository, actor, input.skillId);

  const skill = await repository.getSkill(input.skillId);
  if (!skill) {
    throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Skill not found', 404);
  }
  if (skill.revision !== String(input.expectedRevision)) {
    throw new SkillRepositoryError(
      'REVISION_CONFLICT',
      `expectedRevision ${input.expectedRevision} does not match current ${skill.revision}`,
    );
  }

  const target = await repository.getVersion(input.skillId, input.targetVersion);
  if (!target) {
    throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Target version not found', 404);
  }
  if (target.state !== 'published') {
    throw new SkillRepositoryError(
      'VERSION_NOT_PUBLISHED',
      `Version ${input.targetVersion} is not published`,
    );
  }
  if (!target.manifestHash) {
    throw new SkillRepositoryError(
      'VERSION_INCOMPLETE',
      `Version ${input.targetVersion} has no manifest hash`,
    );
  }

  try {
    await releaseStore.verifyRelease(input.skillId, input.targetVersion, target.manifestHash);
  } catch {
    // Also try rematerialize from blobs if release dir missing but blobs intact
    const files = await repository.listFiles(input.skillId, input.targetVersion);
    for (const file of files) {
      const ok = await service.deps.blobStore.exists(file.blobHash);
      if (!ok) {
        throw new SkillRepositoryError(
          'VERSION_INCOMPLETE',
          `Cannot rollback: version ${input.targetVersion} files incomplete`,
          422,
        );
      }
    }
    try {
      const manifest = buildManifest(
        input.skillId,
        input.targetVersion,
        target.skillMd,
        files,
      );
      const rematerialized = await releaseStore.materialize(
        input.skillId,
        input.targetVersion,
        manifest,
      );
      if (rematerialized.manifestHash !== target.manifestHash) {
        throw new SkillRepositoryError(
          'VERSION_INCOMPLETE',
          `Cannot rollback: manifest hash mismatch for version ${input.targetVersion}`,
          422,
        );
      }
    } catch (error) {
      if (error instanceof SkillRepositoryError) throw error;
      throw new SkillRepositoryError(
        'VERSION_INCOMPLETE',
        `Cannot rollback: version ${input.targetVersion} release incomplete`,
        422,
      );
    }
  }

  const applied = await repository.applyRollbackPointer({
    skillId: input.skillId,
    targetVersion: input.targetVersion,
    expectedRevision: input.expectedRevision,
    actorUserId: actor.userId,
  });

  return {
    skill: applied.skill,
    version: applied.version,
    manifestHash: target.manifestHash,
  };
}

/**
 * Create a new draft from a published version by copying file *references* (blob hashes), not bytes.
 * Published versions remain immutable.
 */
export async function deriveWorkingDraft(
  service: SkillVersionService,
  _actor: SkillActor,
  input: DeriveWorkingDraftInput,
): Promise<{ skill: SkillRecord; version: SkillVersionRecord }> {
  const { repository } = service.deps;
  const skill = await repository.getSkill(input.skillId);
  if (!skill) {
    throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Skill not found', 404);
  }

  const fromVersion = input.fromVersion ?? skill.publishedVersion;
  if (fromVersion == null) {
    throw new SkillRepositoryError(
      'INVALID_INPUT',
      'fromVersion required when skill has no published version',
      400,
    );
  }

  const source = await repository.getVersion(input.skillId, fromVersion);
  if (!source) {
    throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Source version not found', 404);
  }

  const sourceFiles = await repository.listFiles(input.skillId, fromVersion);
  const files: SkillFileInput[] = sourceFiles.map((f) => ({
    path: f.path,
    blobHash: f.blobHash,
    size: f.size,
    mimeType: f.mimeType,
    isText: f.isText,
  }));

  return repository.createWorkingDraft({
    skillId: input.skillId,
    expectedRevision: input.expectedRevision,
    actorUserId: input.actorUserId,
    description: input.description ?? source.description,
    skillMd: input.skillMd ?? source.skillMd,
    runtimeManifest: source.runtimeManifest,
    files,
  });
}

export async function deleteSkillVersion(
  service: SkillVersionService,
  actor: SkillActor,
  input: DeleteSkillVersionArgs,
): Promise<SkillRecord> {
  const hasActivePin =
    input.hasActivePin
    ?? (await service.deps.repository.hasActiveRunPin(input.skillId, input.version).catch(() => false));
  return service.deps.repository.deleteVersion({
    skillId: input.skillId,
    version: input.version,
    expectedRevision: input.expectedRevision,
    actorUserId: actor.userId,
    hasActivePin,
  });
}

/** Protect resource verification/materialization through the pointer commit. */
export function publishSkill(service: SkillVersionService, actor: SkillActor, input: PublishSkillInput): Promise<SkillPublishResult> {
  return withSkillStorageReadLock(service.deps.pool, () => publishSkillUnlocked(service, actor, input));
}

/** Protect resource verification/materialization through the pointer commit. */
export function rollbackSkill(service: SkillVersionService, actor: SkillActor, input: RollbackSkillInput): Promise<SkillPublishResult> {
  return withSkillStorageReadLock(service.deps.pool, () => rollbackSkillUnlocked(service, actor, input));
}
