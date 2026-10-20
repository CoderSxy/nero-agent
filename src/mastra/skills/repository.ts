import type { Pool, PoolClient } from 'pg';
import { SkillRepositoryError } from './errors';
import { withSkillStorageReadLock } from './storage-lock';
import { normalizeSkillPath, pathCollisionKey, assertWithinFileCount, assertWithinFileLimit, assertWithinVersionTotal, isCanonicalSkillName, isValidAlias, SKILL_LIMITS } from './validation';
import type {
  ApplyDraftPackageInput,
  CreateSkillDraftInput,
  CreateWorkingDraftInput,
  SkillActor,
  SkillAudienceRecord,
  SkillEventRecord,
  SkillFileInput,
  SkillFileRecord,
  SkillGrantInput,
  SkillGrantPermission,
  SkillGroupRecord,
  SkillListPage,
  SkillPageQuery,
  SkillPin,
  SkillRecord,
  SkillRunPinRecord,
  SkillRuntimeManifest,
  SkillSyncSessionInput,
  SkillSyncSessionRecord,
  SkillUserPickerItem,
  SkillVersionRecord,
  SkillVersionSummary,
  UpdateSkillDraftInput,
  UpdateSkillMetadataInput,
} from './types';

/** Validate the complete version, including its implicit SKILL.md entry. */
export function validateSkillVersionResources(skillMd: string, files: readonly Pick<SkillFileInput, 'path' | 'size'>[]): void {
  assertWithinFileCount(files.length + 1);
  let total = Buffer.byteLength(skillMd, 'utf8');
  const paths = new Set(['skill.md']);
  for (const file of files) {
    const normalized = normalizeSkillPath(file.path);
    const key = pathCollisionKey(normalized);
    if (normalized !== file.path || paths.has(key)) {
      throw new SkillRepositoryError('INVALID_INPUT', `Resource path collision or noncanonical path: ${file.path}`, 400);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new SkillRepositoryError('INVALID_INPUT', 'Invalid resource size', 400);
    paths.add(key);
    assertWithinFileLimit(file.size, file.path);
    total += file.size;
  }
  assertWithinVersionTotal(total);
}

export type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Fixed namespace for cross-table canonicalName/alias uniqueness. */
export const SKILL_NAME_NAMESPACE_LOCK = 'app_skill_name_namespace';

type SkillRow = {
  id: string;
  canonical_name: string;
  owner_user_id: string;
  group_id: string | null;
  visibility: SkillRecord['visibility'];
  enabled: boolean;
  published_version: number | null;
  revision: string | number | bigint;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type VersionRow = {
  skill_id: string;
  version: number;
  state: SkillVersionRecord['state'];
  description: string;
  skill_md: string;
  manifest_hash: string | null;
  runtime_manifest: SkillRuntimeManifest | null;
  created_by: string;
  published_by: string | null;
  published_at: Date | null;
  published_remark: string | null;
  revision: string | number | bigint;
  created_at: Date;
  updated_at: Date;
};

type FileRow = {
  skill_id: string;
  version: number;
  path: string;
  blob_hash: string;
  size: string | number | bigint;
  mime_type: string | null;
  is_text: boolean;
};

const SKILL_SELECT = `
  id, canonical_name, owner_user_id, group_id, visibility, enabled,
  published_version, revision, deleted_at, created_at, updated_at
`;

const SKILL_SELECT_S = `
  s.id, s.canonical_name, s.owner_user_id, s.group_id, s.visibility, s.enabled,
  s.published_version, s.revision, s.deleted_at, s.created_at, s.updated_at
`;

const VERSION_SELECT = `
  skill_id, version, state, description, skill_md, manifest_hash, runtime_manifest,
  created_by, published_by, published_at, published_remark, revision, created_at, updated_at
`;

const VERSION_SELECT_V = `
  v.skill_id, v.version, v.state, v.description, v.skill_md, v.manifest_hash, v.runtime_manifest,
  v.created_by, v.published_by, v.published_at, v.published_remark, v.revision, v.created_at, v.updated_at
`;

function revisionToString(value: string | number | bigint): string {
  return typeof value === 'bigint' ? value.toString(10) : String(value);
}

function toSkill(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    canonicalName: row.canonical_name,
    ownerUserId: row.owner_user_id,
    groupId: row.group_id,
    visibility: row.visibility,
    enabled: row.enabled,
    publishedVersion: row.published_version,
    revision: revisionToString(row.revision),
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toVersion(row: VersionRow): SkillVersionRecord {
  return {
    skillId: row.skill_id,
    version: row.version,
    state: row.state,
    description: row.description,
    skillMd: row.skill_md,
    manifestHash: row.manifest_hash,
    runtimeManifest: row.runtime_manifest,
    createdBy: row.created_by,
    publishedBy: row.published_by,
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
    publishedRemark: row.published_remark,
    revision: revisionToString(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toFile(row: FileRow): SkillFileRecord {
  return {
    skillId: row.skill_id,
    version: row.version,
    path: row.path,
    blobHash: row.blob_hash,
    size: typeof row.size === 'bigint' ? Number(row.size) : Number(row.size),
    mimeType: row.mime_type,
    isText: row.is_text,
  };
}

function clampPage(page: SkillPageQuery): { page: number; pageSize: number; offset: number } {
  const pageNum = Number.isFinite(page.page) && page.page >= 1 ? Math.floor(page.page) : 1;
  const rawSize = Number.isFinite(page.pageSize) ? Math.floor(page.pageSize) : SKILL_LIMITS.PAGE_DEFAULT;
  const pageSize = Math.min(SKILL_LIMITS.PAGE_MAX, Math.max(1, rawSize || SKILL_LIMITS.PAGE_DEFAULT));
  return { page: pageNum, pageSize, offset: (pageNum - 1) * pageSize };
}

function isAdmin(actor: SkillActor): boolean {
  return actor.roles.includes('admin');
}

async function lockNameNamespace(db: Queryable): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SKILL_NAME_NAMESPACE_LOCK]);
}

async function assertNameAvailable(
  db: Queryable,
  canonicalName: string,
  alias: string | null | undefined,
  exceptSkillId?: string,
): Promise<void> {
  const names = [canonicalName];
  if (alias) names.push(alias);

  const skillConflict = await db.query<{ id: string; canonical_name: string }>(
    `SELECT id, canonical_name FROM app_skills
     WHERE canonical_name = ANY($1::text[])
       AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [names, exceptSkillId ?? null],
  );
  if (skillConflict.rows[0]) {
    throw new SkillRepositoryError(
      'NAME_CONFLICT',
      `Name "${skillConflict.rows[0].canonical_name}" conflicts with an existing skill`,
    );
  }

  const aliasConflict = await db.query<{ alias: string }>(
    `SELECT alias FROM app_skill_aliases
     WHERE alias = ANY($1::text[])
       AND ($2::uuid IS NULL OR skill_id <> $2::uuid)`,
    [names, exceptSkillId ?? null],
  );
  if (aliasConflict.rows[0]) {
    throw new SkillRepositoryError(
      'NAME_CONFLICT',
      `Name "${aliasConflict.rows[0].alias}" conflicts with an existing alias`,
    );
  }
}

/**
 * Next version number from app_skills.version_seq (monotonic).
 * Never reuses numbers after a version row is deleted.
 */
export async function allocateNextVersion(db: Queryable, skillId: string): Promise<number> {
  const result = await db.query<{ version_seq: number }>(
    `UPDATE app_skills
     SET version_seq = version_seq + 1, updated_at = now()
     WHERE id = $1
     RETURNING version_seq`,
    [skillId],
  );
  const next = result.rows[0]?.version_seq;
  if (next == null) {
    throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Skill not found', 404);
  }
  return Number(next);
}

async function insertFiles(
  db: Queryable,
  skillId: string,
  version: number,
  files: SkillFileInput[] | undefined,
): Promise<void> {
  if (!files?.length) return;
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new SkillRepositoryError('INVALID_INPUT', `Duplicate file path: ${file.path}`, 400);
    }
    seen.add(file.path);
    await db.query(
      `INSERT INTO app_skill_files (skill_id, version, path, blob_hash, size, mime_type, is_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [skillId, version, file.path, file.blobHash, file.size, file.mimeType ?? null, file.isText],
    );
  }
}

async function insertEvent(
  db: Queryable,
  input: {
    skillId: string;
    version?: number | null;
    actorUserId: string;
    event: string;
    result?: string | null;
    errorCode?: string | null;
    safeMetadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO app_skill_events (
       skill_id, version, actor_user_id, event, result, error_code, safe_metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.skillId,
      input.version ?? null,
      input.actorUserId,
      input.event,
      input.result ?? null,
      input.errorCode ?? null,
      input.safeMetadata ? JSON.stringify(input.safeMetadata) : null,
    ],
  );
}

async function lockSkillRow(db: Queryable, skillId: string): Promise<SkillRow> {
  const result = await db.query<SkillRow>(
    `SELECT ${SKILL_SELECT} FROM app_skills WHERE id = $1 FOR UPDATE`,
    [skillId],
  );
  const row = result.rows[0];
  if (!row || row.deleted_at) {
    throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Skill not found', 404);
  }
  return row;
}

function assertExpectedRevision(row: SkillRow, expectedRevision: string): void {
  if (revisionToString(row.revision) !== String(expectedRevision)) {
    throw new SkillRepositoryError(
      'REVISION_CONFLICT',
      `expectedRevision ${expectedRevision} does not match current ${revisionToString(row.revision)}`,
    );
  }
}

function validateCreateDraftInput(input: CreateSkillDraftInput): void {
  if (!isCanonicalSkillName(input.canonicalName)) {
    throw new SkillRepositoryError('INVALID_INPUT', 'canonicalName is invalid', 400);
  }
  if (!input.description || input.description.length > SKILL_LIMITS.DESCRIPTION_MAX) {
    throw new SkillRepositoryError('INVALID_INPUT', 'description is invalid', 400);
  }
  if (!input.skillMd || Buffer.byteLength(input.skillMd, 'utf8') > SKILL_LIMITS.SKILL_MD_MAX_BYTES) {
    throw new SkillRepositoryError('INVALID_INPUT', 'skillMd is invalid or too large', 400);
  }
  if (input.alias != null && input.alias !== '' && !isValidAlias(input.alias)) {
    throw new SkillRepositoryError('INVALID_INPUT', 'alias is invalid', 400);
  }
}

export type ApplyPublishPointerInput = {
  skillId: string;
  version: number;
  expectedRevision: string;
  actorUserId: string;
  manifestHash: string;
  remark: string | null;
  runtimeManifest?: SkillRuntimeManifest | null;
};

export type ApplyRollbackPointerInput = {
  skillId: string;
  targetVersion: number;
  expectedRevision: string;
  actorUserId: string;
};

export type DeleteSkillVersionInput = {
  skillId: string;
  version: number;
  expectedRevision: string;
  actorUserId: string;
  /** When true, treat version as referenced by an active run pin (Task 5 wires real pins). */
  hasActivePin?: boolean;
};

export type SkillAccessSnapshot = {
  skill: SkillRecord;
  grants: SkillGrantPermission[];
  audienceUse: boolean;
};

export type SkillNameResolution = {
  skill: SkillRecord;
  matchedAs: 'canonical' | 'alias';
  matchedName: string;
};

export type UpsertDraftFileInput = {
  runtimeManifest?: SkillRuntimeManifest | null;
  skillId: string;
  expectedRevision: string;
  actorUserId: string;
  file: SkillFileInput;
};

export type SkillRepository = {
  /** Production repositories coordinate pin recovery with resource GC. */
  withStorageReadLock?: <T>(operation: () => Promise<T>) => Promise<T>;
  transaction: <T>(fn: (repo: SkillRepository) => Promise<T>) => Promise<T>;
  createDraft: (input: CreateSkillDraftInput) => Promise<{ skill: SkillRecord; version: SkillVersionRecord }>;
  /** Allocates next version_seq draft; used by tests and publish flow. */
  createWorkingDraft: (
    input: CreateWorkingDraftInput,
  ) => Promise<{ skill: SkillRecord; version: SkillVersionRecord }>;
  getSkill: (id: string) => Promise<SkillRecord | null>;
  getVersion: (id: string, version: number) => Promise<SkillVersionRecord | null>;
  getDraftVersion: (skillId: string) => Promise<SkillVersionRecord | null>;
  /** Exact match on canonical_name or alias; soft-deleted skills are not resolved. */
  resolveByName: (name: string) => Promise<SkillNameResolution | null>;
  /**
   * Fresh permission inputs for a skill. Throws on DB errors (caller must fail closed).
   * Returns null when skill missing or soft-deleted.
   */
  getAccessSnapshot: (skillId: string, userId: string) => Promise<SkillAccessSnapshot | null>;
  getFile: (skillId: string, version: number, path: string) => Promise<SkillFileRecord | null>;
  listFiles: (skillId: string, version: number) => Promise<SkillFileRecord[]>;
  listAvailable: (actor: SkillActor, page: SkillPageQuery) => Promise<SkillListPage<SkillRecord>>;
  listManageable: (actor: SkillActor, page: SkillPageQuery) => Promise<SkillListPage<SkillRecord>>;
  listEvents: (skillId: string, page: SkillPageQuery) => Promise<SkillListPage<SkillEventRecord>>;
  updateDraft: (input: UpdateSkillDraftInput) => Promise<{ skill: SkillRecord; version: SkillVersionRecord }>;
  upsertDraftFile: (
    input: UpsertDraftFileInput,
  ) => Promise<{ skill: SkillRecord; version: SkillVersionRecord; file: SkillFileRecord }>;
  updateMetadata: (input: UpdateSkillMetadataInput) => Promise<SkillRecord>;
  /**
   * Under skill row lock + expectedRevision: mark version published and move published_version.
   * Does not change enabled. Caller must have already materialized the release.
   */
  applyPublishPointer: (
    input: ApplyPublishPointerInput,
  ) => Promise<{ skill: SkillRecord; version: SkillVersionRecord }>;
  /** Under skill row lock: point published_version at an already-published complete version. */
  applyRollbackPointer: (
    input: ApplyRollbackPointerInput,
  ) => Promise<{ skill: SkillRecord; version: SkillVersionRecord }>;
  /** Soft-fail delete of a version row; refuses current pointer / active pin. */
  deleteVersion: (input: DeleteSkillVersionInput) => Promise<SkillRecord>;
  listVersions: (skillId: string) => Promise<SkillVersionSummary[]>;
  deleteDraftFile: (input: {
    skillId: string;
    expectedRevision: string;
    actorUserId: string;
    path: string;
  }) => Promise<{ skill: SkillRecord; version: SkillVersionRecord }>;
  listGroups: () => Promise<SkillGroupRecord[]>;
  createGroup: (input: { name: string; sort?: number }) => Promise<SkillGroupRecord>;
  updateGroup: (input: { id: string; name?: string; sort?: number }) => Promise<SkillGroupRecord>;
  deleteGroup: (id: string) => Promise<void>;
  listAudiences: () => Promise<SkillAudienceRecord[]>;
  createAudience: (input: { name: string; memberIds?: string[] }) => Promise<SkillAudienceRecord>;
  updateAudience: (input: {
    id: string;
    name?: string;
    memberIds?: string[];
  }) => Promise<SkillAudienceRecord>;
  deleteAudience: (id: string) => Promise<void>;
  userOwnsAnySkill: (userId: string) => Promise<boolean>;
  searchUsers: (q: string, limit: number) => Promise<SkillUserPickerItem[]>;
  listGrants: (skillId: string) => Promise<SkillGrantInput[]>;
  listAudienceIdsForSkill: (skillId: string) => Promise<string[]>;
  applyDraftPackage: (
    input: ApplyDraftPackageInput,
  ) => Promise<{ skill: SkillRecord; version: SkillVersionRecord }>;
  recordSkillEvent: (input: {
    skillId: string;
    version?: number | null;
    actorUserId: string;
    event: string;
    result?: string | null;
    safeMetadata?: Record<string, unknown> | null;
  }) => Promise<void>;
  insertSyncSession: (input: SkillSyncSessionInput) => Promise<void>;
  lockSyncSession: (id: string) => Promise<SkillSyncSessionRecord | null>;
  consumeSyncSession: (id: string, skillId: string | null) => Promise<boolean>;
  /** Persist a run pin bound to real userId/threadId/serverExecutionId. */
  upsertRunPin: (input: {
    serverExecutionId: string;
    userId: string;
    threadId: string;
    pin: SkillPin;
    ttlMs?: number;
  }) => Promise<SkillRunPinRecord>;
  /** Load non-expired pins for one execution (must match user + thread). */
  listRunPins: (input: {
    serverExecutionId: string;
    userId: string;
    threadId: string;
  }) => Promise<SkillRunPinRecord[]>;
  /** True when any non-expired pin references this skill version. */
  hasActiveRunPin: (skillId: string, version: number) => Promise<boolean>;
  /** Renew only pins observed under the caller's shared storage lease. */
  touchRunPins: (input: {
    serverExecutionId: string;
    userId: string;
    threadId: string;
    skillIds: string[];
    ttlMs?: number;
  }) => Promise<void>;
};

function createBoundRepository(pool: Pool, client: PoolClient | null): SkillRepository {
  const queryable = (): Queryable => client ?? pool;

  async function validateStoredResources(db: PoolClient, skillId: string, version: number, skillMd: string): Promise<void> {
    const files = await db.query<FileRow>(`SELECT skill_id, version, path, blob_hash, size, mime_type, is_text FROM app_skill_files WHERE skill_id = $1 AND version = $2`, [skillId, version]);
    validateSkillVersionResources(skillMd, files.rows.map(toFile));
  }

  async function runWrite<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    if (client) return work(client);
    const owned = await pool.connect();
    try {
      await owned.query('BEGIN');
      const result = await work(owned);
      await owned.query('COMMIT');
      return result;
    } catch (error) {
      await owned.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      owned.release();
    }
  }

  return {
    withStorageReadLock: operation => withSkillStorageReadLock(pool, operation),
    async transaction<T>(fn: (txRepo: SkillRepository) => Promise<T>): Promise<T> {
      if (client) {
        return fn(createBoundRepository(pool, client));
      }
      const owned = await pool.connect();
      try {
        await owned.query('BEGIN');
        const result = await fn(createBoundRepository(pool, owned));
        await owned.query('COMMIT');
        return result;
      } catch (error) {
        await owned.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        owned.release();
      }
    },

    async createDraft(input) {
      validateCreateDraftInput(input);
      const actorUserId = input.actorUserId ?? input.ownerUserId;
      const alias = input.alias && input.alias !== '' ? input.alias : null;

      return runWrite(async (db) => {
        await lockNameNamespace(db);
        await assertNameAvailable(db, input.canonicalName, alias);

        const skillResult = await db.query<SkillRow>(
          `INSERT INTO app_skills (
             canonical_name, owner_user_id, group_id, visibility, enabled, version_seq, revision
           ) VALUES ($1, $2, $3, 'private', false, 1, 1)
           RETURNING ${SKILL_SELECT}`,
          [input.canonicalName, input.ownerUserId, input.groupId ?? null],
        );
        const skillRow = skillResult.rows[0]!;
        const versionNumber = 1;

        const versionResult = await db.query<VersionRow>(
          `INSERT INTO app_skill_versions (
             skill_id, version, state, description, skill_md, runtime_manifest, created_by, revision
           ) VALUES ($1, $2, 'draft', $3, $4, $5, $6, 1)
           RETURNING ${VERSION_SELECT}`,
          [
            skillRow.id,
            versionNumber,
            input.description,
            input.skillMd,
            input.runtimeManifest ? JSON.stringify(input.runtimeManifest) : null,
            actorUserId,
          ],
        );

        if (alias) {
          await db.query(
            `INSERT INTO app_skill_aliases (alias, skill_id) VALUES ($1, $2)`,
            [alias, skillRow.id],
          );
        }

        await insertFiles(db, skillRow.id, 1, input.files);
        await insertEvent(db, {
          skillId: skillRow.id,
          version: 1,
          actorUserId,
          event: 'create',
          result: 'ok',
          safeMetadata: { canonicalName: input.canonicalName },
        });

        return { skill: toSkill(skillRow), version: toVersion(versionResult.rows[0]!) };
      });
    },

    async createWorkingDraft(input) {
      if (!input.description || input.description.length > SKILL_LIMITS.DESCRIPTION_MAX) {
        throw new SkillRepositoryError('INVALID_INPUT', 'description is invalid', 400);
      }
      if (!input.skillMd || Buffer.byteLength(input.skillMd, 'utf8') > SKILL_LIMITS.SKILL_MD_MAX_BYTES) {
        throw new SkillRepositoryError('INVALID_INPUT', 'skillMd is invalid or too large', 400);
      }

      return runWrite(async (db) => {
        const skillRow = await lockSkillRow(db, input.skillId);
        assertExpectedRevision(skillRow, input.expectedRevision);

        const existingDraft = await db.query(
          `SELECT 1 FROM app_skill_versions WHERE skill_id = $1 AND state = 'draft'`,
          [input.skillId],
        );
        if ((existingDraft.rowCount ?? 0) > 0) {
          throw new SkillRepositoryError('DRAFT_EXISTS', 'Skill already has a draft version');
        }

        const nextVersion = await allocateNextVersion(db, input.skillId);
        const versionResult = await db.query<VersionRow>(
          `INSERT INTO app_skill_versions (
             skill_id, version, state, description, skill_md, runtime_manifest, created_by, revision
           ) VALUES ($1, $2, 'draft', $3, $4, $5, $6, 1)
           RETURNING ${VERSION_SELECT}`,
          [
            input.skillId,
            nextVersion,
            input.description,
            input.skillMd,
            input.runtimeManifest ? JSON.stringify(input.runtimeManifest) : null,
            input.actorUserId,
          ],
        );

        await insertFiles(db, input.skillId, nextVersion, input.files);

        const updated = await db.query<SkillRow>(
          `UPDATE app_skills
           SET revision = revision + 1, updated_at = now()
           WHERE id = $1
           RETURNING ${SKILL_SELECT}`,
          [input.skillId],
        );

        await insertEvent(db, {
          skillId: input.skillId,
          version: nextVersion,
          actorUserId: input.actorUserId,
          event: 'edit',
          result: 'ok',
          safeMetadata: { action: 'createWorkingDraft', version: nextVersion },
        });

        return { skill: toSkill(updated.rows[0]!), version: toVersion(versionResult.rows[0]!) };
      });
    },

    async getSkill(id) {
      const result = await queryable().query<SkillRow>(
        `SELECT ${SKILL_SELECT} FROM app_skills WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      return result.rows[0] ? toSkill(result.rows[0]) : null;
    },

    async getVersion(id, version) {
      const result = await queryable().query<VersionRow>(
        `SELECT ${VERSION_SELECT_V} FROM app_skill_versions v
         INNER JOIN app_skills s ON s.id = v.skill_id
         WHERE v.skill_id = $1 AND v.version = $2 AND s.deleted_at IS NULL`,
        [id, version],
      );
      return result.rows[0] ? toVersion(result.rows[0]) : null;
    },

    async getDraftVersion(skillId) {
      const result = await queryable().query<VersionRow>(
        `SELECT ${VERSION_SELECT_V} FROM app_skill_versions v
         INNER JOIN app_skills s ON s.id = v.skill_id
         WHERE v.skill_id = $1 AND v.state = 'draft' AND s.deleted_at IS NULL`,
        [skillId],
      );
      return result.rows[0] ? toVersion(result.rows[0]) : null;
    },

    async resolveByName(name) {
      if (!name || typeof name !== 'string') return null;
      const db = queryable();
      const byCanonical = await db.query<SkillRow>(
        `SELECT ${SKILL_SELECT} FROM app_skills
         WHERE canonical_name = $1 AND deleted_at IS NULL`,
        [name],
      );
      if (byCanonical.rows[0]) {
        return {
          skill: toSkill(byCanonical.rows[0]),
          matchedAs: 'canonical' as const,
          matchedName: name,
        };
      }
      const byAlias = await db.query<SkillRow>(
        `SELECT ${SKILL_SELECT_S}
         FROM app_skill_aliases a
         INNER JOIN app_skills s ON s.id = a.skill_id
         WHERE a.alias = $1 AND s.deleted_at IS NULL`,
        [name],
      );
      if (byAlias.rows[0]) {
        return {
          skill: toSkill(byAlias.rows[0]),
          matchedAs: 'alias' as const,
          matchedName: name,
        };
      }
      return null;
    },

    async getAccessSnapshot(skillId, userId) {
      const db = queryable();
      const skillResult = await db.query<SkillRow>(
        `SELECT ${SKILL_SELECT} FROM app_skills WHERE id = $1 AND deleted_at IS NULL`,
        [skillId],
      );
      const skillRow = skillResult.rows[0];
      if (!skillRow) return null;

      const grantsResult = await db.query<{ permission: SkillGrantPermission }>(
        `SELECT permission FROM app_skill_grants
         WHERE skill_id = $1 AND user_id = $2`,
        [skillId, userId],
      );
      const audienceResult = await db.query<{ ok: number }>(
        `SELECT 1 AS ok
         FROM app_skill_audience_grants ag
         INNER JOIN app_skill_audience_members am ON am.audience_id = ag.audience_id
         WHERE ag.skill_id = $1 AND am.user_id = $2
         LIMIT 1`,
        [skillId, userId],
      );

      return {
        skill: toSkill(skillRow),
        grants: grantsResult.rows.map((row) => row.permission),
        audienceUse: (audienceResult.rowCount ?? 0) > 0,
      };
    },

    async getFile(skillId, version, path) {
      const result = await queryable().query<FileRow>(
        `SELECT f.skill_id, f.version, f.path, f.blob_hash, f.size, f.mime_type, f.is_text
         FROM app_skill_files f
         INNER JOIN app_skills s ON s.id = f.skill_id
         WHERE f.skill_id = $1 AND f.version = $2 AND f.path = $3 AND s.deleted_at IS NULL`,
        [skillId, version, path],
      );
      return result.rows[0] ? toFile(result.rows[0]) : null;
    },

    async listFiles(skillId, version) {
      const result = await queryable().query<FileRow>(
        `SELECT f.skill_id, f.version, f.path, f.blob_hash, f.size, f.mime_type, f.is_text
         FROM app_skill_files f
         INNER JOIN app_skills s ON s.id = f.skill_id
         WHERE f.skill_id = $1 AND f.version = $2 AND s.deleted_at IS NULL
         ORDER BY f.path ASC`,
        [skillId, version],
      );
      return result.rows.map(toFile);
    },

    async listAvailable(actor, page) {
      const { page: pageNum, pageSize, offset } = clampPage(page);
      const q = page.q?.trim() ? `%${page.q.trim()}%` : null;
      const groupId = page.groupId ?? null;
      const db = queryable();

      const countResult = await db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM app_skills s
         LEFT JOIN app_skill_versions pv
           ON pv.skill_id = s.id AND pv.version = s.published_version
         WHERE s.deleted_at IS NULL
           AND s.enabled = true
           AND s.published_version IS NOT NULL
           AND ($2::uuid IS NULL OR s.group_id = $2::uuid)
           AND ($3::text IS NULL OR s.canonical_name ILIKE $3 OR COALESCE(pv.description, '') ILIKE $3)
           AND (
             s.owner_user_id = $1
             OR s.visibility = 'global'
             OR EXISTS (
               SELECT 1 FROM app_skill_grants g
               WHERE g.skill_id = s.id AND g.user_id = $1 AND g.permission = 'use'
             )
             OR EXISTS (
               SELECT 1
               FROM app_skill_audience_grants ag
               INNER JOIN app_skill_audience_members am ON am.audience_id = ag.audience_id
               WHERE ag.skill_id = s.id AND am.user_id = $1
             )
           )`,
        [actor.userId, groupId, q],
      );

      const listResult = await db.query<SkillRow>(
        `SELECT ${SKILL_SELECT_S}
         FROM app_skills s
         LEFT JOIN app_skill_versions pv
           ON pv.skill_id = s.id AND pv.version = s.published_version
         WHERE s.deleted_at IS NULL
           AND s.enabled = true
           AND s.published_version IS NOT NULL
           AND ($2::uuid IS NULL OR s.group_id = $2::uuid)
           AND ($3::text IS NULL OR s.canonical_name ILIKE $3 OR COALESCE(pv.description, '') ILIKE $3)
           AND (
             s.owner_user_id = $1
             OR s.visibility = 'global'
             OR EXISTS (
               SELECT 1 FROM app_skill_grants g
               WHERE g.skill_id = s.id AND g.user_id = $1 AND g.permission = 'use'
             )
             OR EXISTS (
               SELECT 1
               FROM app_skill_audience_grants ag
               INNER JOIN app_skill_audience_members am ON am.audience_id = ag.audience_id
               WHERE ag.skill_id = s.id AND am.user_id = $1
             )
           )
         ORDER BY s.canonical_name ASC, s.id ASC
         LIMIT $4 OFFSET $5`,
        [actor.userId, groupId, q, pageSize, offset],
      );

      return {
        items: listResult.rows.map(toSkill),
        total: Number(countResult.rows[0]?.total ?? 0),
        page: pageNum,
        pageSize,
      };
    },

    async listManageable(actor, page) {
      const { page: pageNum, pageSize, offset } = clampPage(page);
      const q = page.q?.trim() ? `%${page.q.trim()}%` : null;
      const groupId = page.groupId ?? null;
      const admin = isAdmin(actor);
      const db = queryable();

      const countResult = await db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM app_skills s
         WHERE s.deleted_at IS NULL
           AND ($2::uuid IS NULL OR s.group_id = $2::uuid)
           AND ($3::text IS NULL OR s.canonical_name ILIKE $3)
           AND (
             $4::boolean = true
             OR s.owner_user_id = $1
             OR EXISTS (
               SELECT 1 FROM app_skill_grants g
               WHERE g.skill_id = s.id AND g.user_id = $1 AND g.permission IN ('edit', 'publish')
             )
           )`,
        [actor.userId, groupId, q, admin],
      );

      const listResult = await db.query<SkillRow>(
        `SELECT ${SKILL_SELECT_S}
         FROM app_skills s
         WHERE s.deleted_at IS NULL
           AND ($2::uuid IS NULL OR s.group_id = $2::uuid)
           AND ($3::text IS NULL OR s.canonical_name ILIKE $3)
           AND (
             $4::boolean = true
             OR s.owner_user_id = $1
             OR EXISTS (
               SELECT 1 FROM app_skill_grants g
               WHERE g.skill_id = s.id AND g.user_id = $1 AND g.permission IN ('edit', 'publish')
             )
           )
         ORDER BY s.updated_at DESC, s.canonical_name ASC, s.id ASC
         LIMIT $5 OFFSET $6`,
        [actor.userId, groupId, q, admin, pageSize, offset],
      );

      return {
        items: listResult.rows.map(toSkill),
        total: Number(countResult.rows[0]?.total ?? 0),
        page: pageNum,
        pageSize,
      };
    },

    async listEvents(skillId, page) {
      const { page: pageNum, pageSize, offset } = clampPage(page);
      const db = queryable();
      const countResult = await db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM app_skill_events WHERE skill_id = $1`,
        [skillId],
      );
      const listResult = await db.query<{
        id: string;
        skill_id: string;
        version: number | null;
        actor_user_id: string;
        event: string;
        server_execution_id: string | null;
        result: string | null;
        error_code: string | null;
        safe_metadata: Record<string, unknown> | null;
        created_at: Date;
      }>(
        `SELECT id, skill_id, version, actor_user_id, event, server_execution_id,
                result, error_code, safe_metadata, created_at
         FROM app_skill_events
         WHERE skill_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [skillId, pageSize, offset],
      );
      return {
        items: listResult.rows.map((row) => ({
          id: row.id,
          skillId: row.skill_id,
          version: row.version,
          actorUserId: row.actor_user_id,
          event: row.event,
          serverExecutionId: row.server_execution_id,
          result: row.result,
          errorCode: row.error_code,
          safeMetadata: row.safe_metadata,
          createdAt: row.created_at.toISOString(),
        })),
        total: Number(countResult.rows[0]?.total ?? 0),
        page: pageNum,
        pageSize,
      };
    },

    async updateDraft(input) {
      if (input.skillMd !== undefined) {
        if (!input.skillMd || Buffer.byteLength(input.skillMd, 'utf8') > SKILL_LIMITS.SKILL_MD_MAX_BYTES) {
          throw new SkillRepositoryError('INVALID_INPUT', 'skillMd is invalid or too large', 400);
        }
      }
      if (input.description !== undefined) {
        if (!input.description || input.description.length > SKILL_LIMITS.DESCRIPTION_MAX) {
          throw new SkillRepositoryError('INVALID_INPUT', 'description is invalid', 400);
        }
      }

      return runWrite(async (db) => {
        const skillRow = await lockSkillRow(db, input.skillId);
        assertExpectedRevision(skillRow, input.expectedRevision);

        const draftResult = await db.query<VersionRow>(
          `SELECT ${VERSION_SELECT} FROM app_skill_versions
           WHERE skill_id = $1 AND state = 'draft'
           FOR UPDATE`,
          [input.skillId],
        );
        const draft = draftResult.rows[0];
        if (!draft) {
          throw new SkillRepositoryError('DRAFT_MISSING', 'No draft version to update', 404);
        }

        const versionResult = await db.query<VersionRow>(
          `UPDATE app_skill_versions
           SET description = COALESCE($3, description),
               skill_md = COALESCE($4, skill_md),
               runtime_manifest = CASE
                 WHEN $5::boolean THEN $6::jsonb
                 ELSE runtime_manifest
               END,
               revision = revision + 1,
               updated_at = now()
           WHERE skill_id = $1 AND version = $2
           RETURNING ${VERSION_SELECT}`,
          [
            input.skillId,
            draft.version,
            input.description ?? null,
            input.skillMd ?? null,
            input.runtimeManifest !== undefined,
            input.runtimeManifest === undefined
              ? null
              : input.runtimeManifest === null
                ? null
                : JSON.stringify(input.runtimeManifest),
          ],
        );

        if (input.files !== undefined) {
          await db.query(
            `DELETE FROM app_skill_files WHERE skill_id = $1 AND version = $2`,
            [input.skillId, draft.version],
          );
          await insertFiles(db, input.skillId, draft.version, input.files);
        }

        await validateStoredResources(db, input.skillId, draft.version, versionResult.rows[0]!.skill_md);

        const updatedSkill = await db.query<SkillRow>(
          `UPDATE app_skills
           SET revision = revision + 1, updated_at = now()
           WHERE id = $1
           RETURNING ${SKILL_SELECT}`,
          [input.skillId],
        );

        await insertEvent(db, {
          skillId: input.skillId,
          version: draft.version,
          actorUserId: input.actorUserId,
          event: 'edit',
          result: 'ok',
        });

        return { skill: toSkill(updatedSkill.rows[0]!), version: toVersion(versionResult.rows[0]!) };
      });
    },

    async upsertDraftFile(input) {
      return runWrite(async (db) => {
        const skillRow = await lockSkillRow(db, input.skillId);
        assertExpectedRevision(skillRow, input.expectedRevision);

        const draftResult = await db.query<VersionRow>(
          `SELECT ${VERSION_SELECT} FROM app_skill_versions
           WHERE skill_id = $1 AND state = 'draft'
           FOR UPDATE`,
          [input.skillId],
        );
        const draft = draftResult.rows[0];
        if (!draft) {
          throw new SkillRepositoryError('DRAFT_MISSING', 'No draft version to update', 404);
        }

        await db.query(
          `INSERT INTO app_skill_files (skill_id, version, path, blob_hash, size, mime_type, is_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (skill_id, version, path) DO UPDATE SET
             blob_hash = EXCLUDED.blob_hash,
             size = EXCLUDED.size,
             mime_type = EXCLUDED.mime_type,
             is_text = EXCLUDED.is_text`,
          [
            input.skillId,
            draft.version,
            input.file.path,
            input.file.blobHash,
            input.file.size,
            input.file.mimeType ?? null,
            input.file.isText,
          ],
        );

        const fileResult = await db.query<FileRow>(
          `SELECT skill_id, version, path, blob_hash, size, mime_type, is_text
           FROM app_skill_files
           WHERE skill_id = $1 AND version = $2 AND path = $3`,
          [input.skillId, draft.version, input.file.path],
        );

        await validateStoredResources(db, input.skillId, draft.version, draft.skill_md);
        const updatedVersion = await db.query<VersionRow>(
          `UPDATE app_skill_versions SET runtime_manifest = CASE WHEN $3::boolean THEN $4::jsonb ELSE runtime_manifest END,
           revision = revision + 1, updated_at = now() WHERE skill_id = $1 AND version = $2 RETURNING ${VERSION_SELECT}`,
          [input.skillId, draft.version, input.runtimeManifest !== undefined,
            input.runtimeManifest === undefined ? null : JSON.stringify(input.runtimeManifest)]);
        const updatedSkill = await db.query<SkillRow>(
          `UPDATE app_skills
           SET revision = revision + 1, updated_at = now()
           WHERE id = $1
           RETURNING ${SKILL_SELECT}`,
          [input.skillId],
        );

        await insertEvent(db, {
          skillId: input.skillId,
          version: draft.version,
          actorUserId: input.actorUserId,
          event: 'edit',
          result: 'ok',
          safeMetadata: { action: 'upsertDraftFile', path: input.file.path },
        });

        return {
          skill: toSkill(updatedSkill.rows[0]!),
          version: toVersion(updatedVersion.rows[0]!),
          file: toFile(fileResult.rows[0]!),
        };
      });
    },

    async updateMetadata(input) {
      return runWrite(async (db) => {
        const skillRow = await lockSkillRow(db, input.skillId);
        assertExpectedRevision(skillRow, input.expectedRevision);

        if (input.enabled === true && skillRow.published_version == null) {
          throw new SkillRepositoryError(
            'INVALID_INPUT',
            'Cannot enable a skill without a published version',
            400,
          );
        }

        const updated = await db.query<SkillRow>(
          `UPDATE app_skills
           SET visibility = COALESCE($2, visibility),
               group_id = CASE WHEN $3::boolean THEN $4::uuid ELSE group_id END,
               enabled = COALESCE($5, enabled),
               deleted_at = CASE
                 WHEN $6::boolean THEN now()
                 ELSE deleted_at
               END,
               revision = revision + 1,
               updated_at = now()
           WHERE id = $1
           RETURNING ${SKILL_SELECT}`,
          [
            input.skillId,
            input.visibility ?? null,
            input.groupId !== undefined,
            input.groupId === undefined ? null : input.groupId,
            input.enabled ?? null,
            input.deleted === true,
          ],
        );

        if (input.grants !== undefined) {
          await db.query(`DELETE FROM app_skill_grants WHERE skill_id = $1`, [input.skillId]);
          for (const grant of input.grants) {
            await db.query(
              `INSERT INTO app_skill_grants (skill_id, user_id, permission)
               VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING`,
              [input.skillId, grant.userId, grant.permission],
            );
          }
        }

        if (input.audienceIds !== undefined) {
          await db.query(`DELETE FROM app_skill_audience_grants WHERE skill_id = $1`, [input.skillId]);
          for (const audienceId of input.audienceIds) {
            await db.query(
              `INSERT INTO app_skill_audience_grants (skill_id, audience_id)
               VALUES ($1, $2)
               ON CONFLICT DO NOTHING`,
              [input.skillId, audienceId],
            );
          }
        }

        const eventName = input.deleted
          ? 'delete'
          : input.enabled === true
            ? 'enable'
            : input.enabled === false
              ? 'disable'
              : input.grants !== undefined || input.audienceIds !== undefined
                ? 'grant'
                : 'edit';
        await insertEvent(db, {
          skillId: input.skillId,
          actorUserId: input.actorUserId,
          event: eventName,
          result: 'ok',
          safeMetadata: {
            visibility: input.visibility,
            groupId: input.groupId,
            enabled: input.enabled,
            deleted: input.deleted,
            grantCount: input.grants?.length,
            audienceCount: input.audienceIds?.length,
          },
        });

        return toSkill(updated.rows[0]!);
      });
    },

    async applyPublishPointer(input) {
      return runWrite(async (db) => {
        const skillRow = await lockSkillRow(db, input.skillId);
        assertExpectedRevision(skillRow, input.expectedRevision);

        const versionResult = await db.query<VersionRow>(
          `SELECT ${VERSION_SELECT} FROM app_skill_versions
           WHERE skill_id = $1 AND version = $2
           FOR UPDATE`,
          [input.skillId, input.version],
        );
        const versionRow = versionResult.rows[0];
        if (!versionRow) {
          throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Version not found', 404);
        }
        if (versionRow.state !== 'draft') {
          throw new SkillRepositoryError(
            'VERSION_NOT_DRAFT',
            `Version ${input.version} is not a draft`,
          );
        }

        await validateStoredResources(db, input.skillId, input.version, versionRow.skill_md);
        const published = await db.query<VersionRow>(
          `UPDATE app_skill_versions
           SET state = 'published',
               manifest_hash = $3,
               runtime_manifest = CASE WHEN $6::boolean THEN $7::jsonb ELSE runtime_manifest END,
               published_by = $4,
               published_at = now(),
               published_remark = $5,
               revision = revision + 1,
               updated_at = now()
           WHERE skill_id = $1 AND version = $2 AND state = 'draft'
           RETURNING ${VERSION_SELECT}`,
          [
            input.skillId,
            input.version,
            input.manifestHash,
            input.actorUserId,
            input.remark,
            input.runtimeManifest !== undefined,
            input.runtimeManifest == null ? null : JSON.stringify(input.runtimeManifest),
          ],
        );
        if (!published.rows[0]) {
          throw new SkillRepositoryError(
            'VERSION_NOT_DRAFT',
            `Version ${input.version} is not a draft`,
          );
        }

        // Keep enabled unchanged (first publish stays false; already-enabled stays true).
        const updatedSkill = await db.query<SkillRow>(
          `UPDATE app_skills
           SET published_version = $2,
               revision = revision + 1,
               updated_at = now()
           WHERE id = $1
           RETURNING ${SKILL_SELECT}`,
          [input.skillId, input.version],
        );

        await insertEvent(db, {
          skillId: input.skillId,
          version: input.version,
          actorUserId: input.actorUserId,
          event: 'publish',
          result: 'ok',
          safeMetadata: {
            manifestHash: input.manifestHash,
            remark: input.remark,
            enabled: updatedSkill.rows[0]!.enabled,
          },
        });

        return { skill: toSkill(updatedSkill.rows[0]!), version: toVersion(published.rows[0]!) };
      });
    },

    async applyRollbackPointer(input) {
      return runWrite(async (db) => {
        const skillRow = await lockSkillRow(db, input.skillId);
        assertExpectedRevision(skillRow, input.expectedRevision);

        const versionResult = await db.query<VersionRow>(
          `SELECT ${VERSION_SELECT} FROM app_skill_versions
           WHERE skill_id = $1 AND version = $2
           FOR UPDATE`,
          [input.skillId, input.targetVersion],
        );
        const versionRow = versionResult.rows[0];
        if (!versionRow) {
          throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Target version not found', 404);
        }
        if (versionRow.state !== 'published') {
          throw new SkillRepositoryError(
            'VERSION_NOT_PUBLISHED',
            `Version ${input.targetVersion} is not published`,
          );
        }
        if (!versionRow.manifest_hash) {
          throw new SkillRepositoryError(
            'VERSION_INCOMPLETE',
            `Version ${input.targetVersion} is missing manifest_hash`,
          );
        }

        const updatedSkill = await db.query<SkillRow>(
          `UPDATE app_skills
           SET published_version = $2,
               revision = revision + 1,
               updated_at = now()
           WHERE id = $1
           RETURNING ${SKILL_SELECT}`,
          [input.skillId, input.targetVersion],
        );

        await insertEvent(db, {
          skillId: input.skillId,
          version: input.targetVersion,
          actorUserId: input.actorUserId,
          event: 'rollback',
          result: 'ok',
          safeMetadata: {
            fromVersion: skillRow.published_version,
            toVersion: input.targetVersion,
            manifestHash: versionRow.manifest_hash,
          },
        });

        return { skill: toSkill(updatedSkill.rows[0]!), version: toVersion(versionRow) };
      });
    },

    async deleteVersion(input) {
      return runWrite(async (db) => {
        const skillRow = await lockSkillRow(db, input.skillId);
        assertExpectedRevision(skillRow, input.expectedRevision);

        if (skillRow.published_version === input.version) {
          throw new SkillRepositoryError(
            'VERSION_IN_USE',
            'Cannot delete the version referenced by the current publish pointer',
          );
        }
        const activePin = await db.query(
          `SELECT 1 FROM app_skill_run_pins
           WHERE skill_id = $1 AND version = $2 AND expires_at > now()
           LIMIT 1`,
          [input.skillId, input.version],
        );
        if (input.hasActivePin || (activePin.rowCount ?? 0) > 0) {
          throw new SkillRepositoryError(
            'VERSION_IN_USE',
            'Cannot delete a version referenced by an active run pin',
          );
        }

        const versionResult = await db.query<VersionRow>(
          `SELECT ${VERSION_SELECT} FROM app_skill_versions
           WHERE skill_id = $1 AND version = $2
           FOR UPDATE`,
          [input.skillId, input.version],
        );
        if (!versionResult.rows[0]) {
          throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Version not found', 404);
        }

        await db.query(
          `DELETE FROM app_skill_versions WHERE skill_id = $1 AND version = $2`,
          [input.skillId, input.version],
        );

        const updatedSkill = await db.query<SkillRow>(
          `UPDATE app_skills
           SET revision = revision + 1, updated_at = now()
           WHERE id = $1
           RETURNING ${SKILL_SELECT}`,
          [input.skillId],
        );

        await insertEvent(db, {
          skillId: input.skillId,
          version: input.version,
          actorUserId: input.actorUserId,
          event: 'delete',
          result: 'ok',
          safeMetadata: { action: 'deleteVersion', version: input.version },
        });

        return toSkill(updatedSkill.rows[0]!);
      });
    },

    async upsertRunPin(input) {
      const ttlMs = input.ttlMs ?? SKILL_LIMITS.RUN_PIN_TTL_MS;
      const expiresAt = new Date(Date.now() + ttlMs);
      const result = await queryable().query<{
        server_execution_id: string;
        skill_id: string;
        user_id: string;
        thread_id: string;
        version: number;
        manifest_hash: string;
        expires_at: Date;
      }>(
        `INSERT INTO app_skill_run_pins (
           server_execution_id, skill_id, user_id, thread_id, version, manifest_hash, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (server_execution_id, skill_id) DO UPDATE SET
           expires_at = EXCLUDED.expires_at,
           updated_at = now()
         WHERE app_skill_run_pins.user_id = EXCLUDED.user_id
           AND app_skill_run_pins.thread_id = EXCLUDED.thread_id
         RETURNING server_execution_id, skill_id, user_id, thread_id, version, manifest_hash, expires_at`,
        [
          input.serverExecutionId,
          input.pin.skillId,
          input.userId,
          input.threadId,
          input.pin.version,
          input.pin.manifestHash,
          expiresAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new SkillRepositoryError('INVALID_INPUT', 'Execution pin identity conflict', 409);
      return {
        serverExecutionId: row.server_execution_id,
        skillId: row.skill_id,
        name: input.pin.name,
        version: row.version,
        manifestHash: row.manifest_hash,
        userId: row.user_id,
        threadId: row.thread_id,
        expiresAt: row.expires_at.toISOString(),
      };
    },

    async listRunPins(input) {
      const result = await queryable().query<{
        server_execution_id: string;
        skill_id: string;
        user_id: string;
        thread_id: string;
        version: number;
        manifest_hash: string;
        expires_at: Date;
        canonical_name: string;
        instructions_loaded: boolean;
      }>(
        `SELECT p.server_execution_id, p.skill_id, p.user_id, p.thread_id, p.version,
                p.manifest_hash, p.expires_at, s.canonical_name,
                EXISTS (SELECT 1 FROM app_skill_events e
                  WHERE e.skill_id = p.skill_id AND e.version = p.version
                    AND e.server_execution_id = p.server_execution_id
                    AND e.actor_user_id = p.user_id AND e.event = 'load' AND e.result = 'ok') AS instructions_loaded
         FROM app_skill_run_pins p
         JOIN app_skills s ON s.id = p.skill_id
         WHERE p.server_execution_id = $1
           AND p.user_id = $2
           AND p.thread_id = $3
           AND p.expires_at > now()`,
        [input.serverExecutionId, input.userId, input.threadId],
      );
      return result.rows.map((row) => ({
        serverExecutionId: row.server_execution_id,
        skillId: row.skill_id,
        name: row.canonical_name,
        instructionsLoaded: row.instructions_loaded,
        version: row.version,
        manifestHash: row.manifest_hash,
        userId: row.user_id,
        threadId: row.thread_id,
        expiresAt: row.expires_at.toISOString(),
      }));
    },

    async hasActiveRunPin(skillId, version) {
      const result = await queryable().query(
        `SELECT 1 FROM app_skill_run_pins
         WHERE skill_id = $1 AND version = $2 AND expires_at > now()
         LIMIT 1`,
        [skillId, version],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async touchRunPins(input) {
      const ttlMs = input.ttlMs ?? SKILL_LIMITS.RUN_PIN_TTL_MS;
      const expiresAt = new Date(Date.now() + ttlMs);
      await queryable().query(
        `UPDATE app_skill_run_pins
         SET expires_at = $4, updated_at = now()
         WHERE server_execution_id = $1 AND user_id = $2 AND thread_id = $3
           AND skill_id = ANY($5::uuid[])`,
        [input.serverExecutionId, input.userId, input.threadId, expiresAt, input.skillIds],
      );
    },

    async listVersions(skillId) {
      const result = await queryable().query<VersionRow>(
        `SELECT ${VERSION_SELECT} FROM app_skill_versions
         WHERE skill_id = $1
         ORDER BY version DESC`,
        [skillId],
      );
      return result.rows.map((row) => ({
        version: row.version,
        state: row.state,
        description: row.description,
        manifestHash: row.manifest_hash,
        publishedAt: row.published_at ? row.published_at.toISOString() : null,
        publishedRemark: row.published_remark,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async deleteDraftFile(input) {
      return runWrite(async (db) => {
        const skillRow = await lockSkillRow(db, input.skillId);
        assertExpectedRevision(skillRow, input.expectedRevision);
        const draftResult = await db.query<VersionRow>(
          `SELECT ${VERSION_SELECT} FROM app_skill_versions
           WHERE skill_id = $1 AND state = 'draft'
           FOR UPDATE`,
          [input.skillId],
        );
        const draft = draftResult.rows[0];
        if (!draft) {
          throw new SkillRepositoryError('DRAFT_MISSING', 'No draft version to update', 404);
        }
        const deleted = await db.query(
          `DELETE FROM app_skill_files
           WHERE skill_id = $1 AND version = $2 AND path = $3`,
          [input.skillId, draft.version, input.path],
        );
        if ((deleted.rowCount ?? 0) === 0) {
          throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Draft file not found', 404);
        }
        await validateStoredResources(db, input.skillId, draft.version, draft.skill_md);
        const updatedVersion = await db.query<VersionRow>(
          `UPDATE app_skill_versions SET runtime_manifest = CASE WHEN $3::boolean THEN NULL ELSE runtime_manifest END,
           revision = revision + 1, updated_at = now() WHERE skill_id = $1 AND version = $2 RETURNING ${VERSION_SELECT}`,
          [input.skillId, draft.version, input.path === 'skill-runtime.json']);
        const updatedSkill = await db.query<SkillRow>(
          `UPDATE app_skills
           SET revision = revision + 1, updated_at = now()
           WHERE id = $1
           RETURNING ${SKILL_SELECT}`,
          [input.skillId],
        );
        await insertEvent(db, {
          skillId: input.skillId,
          version: draft.version,
          actorUserId: input.actorUserId,
          event: 'edit',
          result: 'ok',
          safeMetadata: { action: 'deleteDraftFile', path: input.path },
        });
        return { skill: toSkill(updatedSkill.rows[0]!), version: toVersion(updatedVersion.rows[0]!) };
      });
    },

    async listGroups() {
      const result = await queryable().query<{
        id: string;
        name: string;
        sort: number;
        created_at: Date;
        updated_at: Date;
      }>(`SELECT id, name, sort, created_at, updated_at FROM app_skill_groups ORDER BY sort ASC, name ASC`);
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        sort: row.sort,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async createGroup(input) {
      try {
        const result = await queryable().query<{
          id: string;
          name: string;
          sort: number;
          created_at: Date;
          updated_at: Date;
        }>(
          `INSERT INTO app_skill_groups (name, sort) VALUES ($1, $2)
           RETURNING id, name, sort, created_at, updated_at`,
          [input.name.trim(), input.sort ?? 0],
        );
        const row = result.rows[0]!;
        return {
          id: row.id,
          name: row.name,
          sort: row.sort,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        };
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new SkillRepositoryError('NAME_CONFLICT', 'Group name already exists');
        }
        throw error;
      }
    },

    async updateGroup(input) {
      const result = await queryable().query<{
        id: string;
        name: string;
        sort: number;
        created_at: Date;
        updated_at: Date;
      }>(
        `UPDATE app_skill_groups
         SET name = COALESCE($2, name),
             sort = COALESCE($3, sort),
             updated_at = now()
         WHERE id = $1
         RETURNING id, name, sort, created_at, updated_at`,
        [input.id, input.name?.trim() ?? null, input.sort ?? null],
      );
      if (!result.rows[0]) {
        throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Group not found', 404);
      }
      const row = result.rows[0];
      return {
        id: row.id,
        name: row.name,
        sort: row.sort,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
    },

    async deleteGroup(id) {
      return runWrite(async (db) => {
        const inUse = await db.query(
          `SELECT 1 FROM app_skills WHERE group_id = $1 AND deleted_at IS NULL LIMIT 1`,
          [id],
        );
        if ((inUse.rowCount ?? 0) > 0) {
          throw new SkillRepositoryError(
            'INVALID_INPUT',
            'Move skills out of the group before deleting it',
            400,
          );
        }
        const deleted = await db.query(`DELETE FROM app_skill_groups WHERE id = $1`, [id]);
        if ((deleted.rowCount ?? 0) === 0) {
          throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Group not found', 404);
        }
      });
    },

    async listAudiences() {
      const audiences = await queryable().query<{
        id: string;
        name: string;
        created_at: Date;
        updated_at: Date;
      }>(`SELECT id, name, created_at, updated_at FROM app_skill_audiences ORDER BY name ASC`);
      const members = await queryable().query<{ audience_id: string; user_id: string }>(
        `SELECT audience_id, user_id FROM app_skill_audience_members`,
      );
      const byAudience = new Map<string, string[]>();
      for (const row of members.rows) {
        const list = byAudience.get(row.audience_id) ?? [];
        list.push(row.user_id);
        byAudience.set(row.audience_id, list);
      }
      return audiences.rows.map((row) => ({
        id: row.id,
        name: row.name,
        memberIds: byAudience.get(row.id) ?? [],
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async createAudience(input) {
      return runWrite(async (db) => {
        let row: { id: string; name: string; created_at: Date; updated_at: Date };
        try {
          const result = await db.query<{
            id: string;
            name: string;
            created_at: Date;
            updated_at: Date;
          }>(
            `INSERT INTO app_skill_audiences (name) VALUES ($1)
             RETURNING id, name, created_at, updated_at`,
            [input.name.trim()],
          );
          row = result.rows[0]!;
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new SkillRepositoryError('NAME_CONFLICT', 'Audience name already exists');
          }
          throw error;
        }
        const memberIds = input.memberIds ?? [];
        for (const userId of memberIds) {
          await db.query(
            `INSERT INTO app_skill_audience_members (audience_id, user_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [row.id, userId],
          );
        }
        return {
          id: row.id,
          name: row.name,
          memberIds,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        };
      });
    },

    async updateAudience(input) {
      return runWrite(async (db) => {
        const result = await db.query<{
          id: string;
          name: string;
          created_at: Date;
          updated_at: Date;
        }>(
          `UPDATE app_skill_audiences
           SET name = COALESCE($2, name), updated_at = now()
           WHERE id = $1
           RETURNING id, name, created_at, updated_at`,
          [input.id, input.name?.trim() ?? null],
        );
        if (!result.rows[0]) {
          throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Audience not found', 404);
        }
        if (input.memberIds !== undefined) {
          await db.query(`DELETE FROM app_skill_audience_members WHERE audience_id = $1`, [input.id]);
          for (const userId of input.memberIds) {
            await db.query(
              `INSERT INTO app_skill_audience_members (audience_id, user_id)
               VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [input.id, userId],
            );
          }
        }
        const members = await db.query<{ user_id: string }>(
          `SELECT user_id FROM app_skill_audience_members WHERE audience_id = $1`,
          [input.id],
        );
        const row = result.rows[0];
        return {
          id: row.id,
          name: row.name,
          memberIds: members.rows.map((m) => m.user_id),
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        };
      });
    },

    async deleteAudience(id) {
      const deleted = await queryable().query(`DELETE FROM app_skill_audiences WHERE id = $1`, [id]);
      if ((deleted.rowCount ?? 0) === 0) {
        throw new SkillRepositoryError('SKILL_NOT_FOUND', 'Audience not found', 404);
      }
    },

    async userOwnsAnySkill(userId) {
      const result = await queryable().query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM app_skills
           WHERE owner_user_id = $1 AND deleted_at IS NULL
         ) AS exists`,
        [userId],
      );
      return result.rows[0]?.exists === true;
    },

    async searchUsers(q, limit) {
      const result = await queryable().query<{ id: string; display_name: string }>(
        `SELECT id, display_name
         FROM app_users
         WHERE status = 'active'
           AND (display_name ILIKE $1 OR email ILIKE $1)
         ORDER BY display_name ASC, id ASC
         LIMIT $2`,
        [`%${q}%`, limit],
      );
      return result.rows.map((row) => ({ id: row.id, displayName: row.display_name }));
    },

    async listGrants(skillId) {
      const result = await queryable().query<{ user_id: string; permission: SkillGrantPermission }>(
        `SELECT user_id, permission FROM app_skill_grants WHERE skill_id = $1
         ORDER BY user_id ASC, permission ASC`,
        [skillId],
      );
      return result.rows.map((row) => ({ userId: row.user_id, permission: row.permission }));
    },

    async listAudienceIdsForSkill(skillId) {
      const result = await queryable().query<{ audience_id: string }>(
        `SELECT audience_id FROM app_skill_audience_grants WHERE skill_id = $1 ORDER BY audience_id`,
        [skillId],
      );
      return result.rows.map((row) => row.audience_id);
    },

    async applyDraftPackage(input) {
      if (input.skillMd !== undefined) {
        if (!input.skillMd || Buffer.byteLength(input.skillMd, 'utf8') > SKILL_LIMITS.SKILL_MD_MAX_BYTES) {
          throw new SkillRepositoryError('INVALID_INPUT', 'skillMd is invalid or too large', 400);
        }
      }
      if (input.description !== undefined) {
        if (!input.description || input.description.length > SKILL_LIMITS.DESCRIPTION_MAX) {
          throw new SkillRepositoryError('INVALID_INPUT', 'description is invalid', 400);
        }
      }
      if (input.canonicalName !== undefined && !isCanonicalSkillName(input.canonicalName)) {
        throw new SkillRepositoryError('INVALID_INPUT', 'canonicalName is invalid', 400);
      }
      if (input.alias) {
        if (!isValidAlias(input.alias)) {
          throw new SkillRepositoryError('INVALID_INPUT', 'alias is invalid', 400);
        }
      }

      return runWrite(async (db) => {
        const skillRow = await lockSkillRow(db, input.skillId);
        assertExpectedRevision(skillRow, input.expectedRevision);

        const nextName = input.canonicalName ?? skillRow.canonical_name;
        if (nextName !== skillRow.canonical_name && skillRow.published_version != null) {
          throw new SkillRepositoryError('NAME_LOCKED', 'Published skill name cannot be changed', 409);
        }
        if (input.alias && input.alias === nextName) {
          throw new SkillRepositoryError('NAME_CONFLICT', 'alias cannot equal canonical name', 409);
        }
        if (nextName !== skillRow.canonical_name || input.alias) {
          await lockNameNamespace(db);
          await assertNameAvailable(db, nextName, input.alias ?? null, skillRow.id);
        }
        if (nextName !== skillRow.canonical_name) {
          await db.query(
            `UPDATE app_skills SET canonical_name = $2, updated_at = now() WHERE id = $1`,
            [input.skillId, nextName],
          );
        }
        if (input.alias !== undefined) {
          await db.query(`DELETE FROM app_skill_aliases WHERE skill_id = $1`, [input.skillId]);
          if (input.alias) {
            await db.query(
              `INSERT INTO app_skill_aliases (alias, skill_id) VALUES ($1, $2)`,
              [input.alias, input.skillId],
            );
          }
        }

        const draftResult = await db.query<VersionRow>(
          `SELECT ${VERSION_SELECT} FROM app_skill_versions
           WHERE skill_id = $1 AND state = 'draft'
           FOR UPDATE`,
          [input.skillId],
        );
        let versionRow = draftResult.rows[0];
        if (!versionRow) {
          if (!input.skillMd || !input.description) {
            throw new SkillRepositoryError('DRAFT_MISSING', 'No draft version to update', 404);
          }
          const nextVersion = await allocateNextVersion(db, input.skillId);
          const inserted = await db.query<VersionRow>(
            `INSERT INTO app_skill_versions (
               skill_id, version, state, description, skill_md, runtime_manifest, created_by, revision
             ) VALUES ($1, $2, 'draft', $3, $4, $5, $6, 1)
             RETURNING ${VERSION_SELECT}`,
            [
              input.skillId,
              nextVersion,
              input.description,
              input.skillMd,
              input.runtimeManifest ? JSON.stringify(input.runtimeManifest) : null,
              input.actorUserId,
            ],
          );
          versionRow = inserted.rows[0]!;
          await insertFiles(db, input.skillId, versionRow.version, input.files);
        } else {
          const updated = await db.query<VersionRow>(
            `UPDATE app_skill_versions
             SET description = COALESCE($3, description),
                 skill_md = COALESCE($4, skill_md),
                 runtime_manifest = CASE
                   WHEN $5::boolean THEN $6::jsonb
                   ELSE runtime_manifest
                 END,
                 revision = revision + 1,
                 updated_at = now()
             WHERE skill_id = $1 AND version = $2
             RETURNING ${VERSION_SELECT}`,
            [
              input.skillId,
              versionRow.version,
              input.description ?? null,
              input.skillMd ?? null,
              input.runtimeManifest !== undefined,
              input.runtimeManifest === undefined
                ? null
                : input.runtimeManifest === null
                  ? null
                  : JSON.stringify(input.runtimeManifest),
            ],
          );
          versionRow = updated.rows[0]!;
          await db.query(
            `DELETE FROM app_skill_files WHERE skill_id = $1 AND version = $2`,
            [input.skillId, versionRow.version],
          );
          await insertFiles(db, input.skillId, versionRow.version, input.files);
        }

        await validateStoredResources(db, input.skillId, versionRow.version, versionRow.skill_md);

        const updatedSkill = await db.query<SkillRow>(
          `UPDATE app_skills
           SET revision = revision + 1, updated_at = now()
           WHERE id = $1
           RETURNING ${SKILL_SELECT}`,
          [input.skillId],
        );
        await insertEvent(db, {
          skillId: input.skillId,
          version: versionRow.version,
          actorUserId: input.actorUserId,
          event: input.event,
          result: 'ok',
          safeMetadata: {
            fileCount: input.files.length,
            renamed: nextName !== skillRow.canonical_name,
          },
        });
        return { skill: toSkill(updatedSkill.rows[0]!), version: toVersion(versionRow) };
      });
    },

    async recordSkillEvent(input) {
      await runWrite(async (db) => {
        await insertEvent(db, input);
      });
    },

    async insertSyncSession(input) {
      await runWrite(async (db) => {
        await db.query(
          `INSERT INTO app_skill_sync_sessions (
             id, kind, skill_id, base_revision, version, actor_user_id, payload, temp_root, expires_at, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'pending')`,
          [
            input.id,
            input.kind,
            input.skillId,
            input.baseRevision,
            input.version,
            input.actorUserId,
            JSON.stringify(input.payload ?? {}),
            input.tempRoot,
            input.expiresAt,
          ],
        );
      });
    },

    async lockSyncSession(id) {
      const result = await queryable().query<{
        id: string;
        kind: 'import' | 'sync';
        skill_id: string | null;
        base_revision: string | null;
        version: number | null;
        actor_user_id: string;
        payload: unknown;
        temp_root: string;
        expires_at: Date;
        status: 'pending' | 'committed' | 'aborted';
      }>(
        `SELECT id, kind, skill_id, base_revision, version, actor_user_id, payload, temp_root, expires_at, status
         FROM app_skill_sync_sessions
         WHERE id = $1
         FOR UPDATE`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        kind: row.kind,
        skillId: row.skill_id,
        baseRevision: row.base_revision == null ? null : String(row.base_revision),
        version: row.version,
        actorUserId: row.actor_user_id,
        payload: row.payload,
        tempRoot: row.temp_root,
        expiresAt: row.expires_at,
        status: row.status,
      };
    },

    async consumeSyncSession(id, skillId) {
      const result = await queryable().query(
        `UPDATE app_skill_sync_sessions
         SET status = 'committed', skill_id = COALESCE($2::uuid, skill_id)
         WHERE id = $1 AND status = 'pending'`,
        [id, skillId],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export function createSkillRepository(pool: Pool): SkillRepository {
  return createBoundRepository(pool, null);
}
