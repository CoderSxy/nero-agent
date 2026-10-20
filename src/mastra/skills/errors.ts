export type SkillPackageErrorCode =
  | 'SKILL_MD_MISSING'
  | 'SKILL_MD_AMBIGUOUS'
  | 'SKILL_MD_TOO_LARGE'
  | 'SKILL_MD_BINARY'
  | 'SKILL_MD_INVALID'
  | 'PATH_INVALID'
  | 'PATH_COLLISION'
  | 'PATH_SYMLINK'
  | 'PATH_HARDLINK'
  | 'PATH_SPECIAL_FILE'
  | 'FILE_TOO_LARGE'
  | 'VERSION_TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'JSON_TOO_LARGE'
  | 'JSON_INVALID'
  | 'RUNTIME_SCHEMA_UNSUPPORTED'
  | 'ZIP_TOO_LARGE'
  | 'ZIP_EXPAND_TOO_LARGE'
  | 'ZIP_INVALID'
  | 'IMPORT_TEMP_UNAVAILABLE'
  | 'YAML_INVALID';

export class SkillPackageError extends Error {
  readonly code: SkillPackageErrorCode;
  readonly status: number;

  constructor(code: SkillPackageErrorCode, message: string, status = 422) {
    super(message);
    this.name = 'SkillPackageError';
    this.code = code;
    this.status = status;
  }
}

export type SkillRepositoryErrorCode =
  | 'REVISION_CONFLICT'
  | 'NAME_CONFLICT'
  | 'DRAFT_EXISTS'
  | 'DRAFT_MISSING'
  | 'SKILL_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'VERSION_NOT_DRAFT'
  | 'VERSION_NOT_PUBLISHED'
  | 'VERSION_IN_USE'
  | 'VERSION_INCOMPLETE'
  | 'NAME_LOCKED'
  | 'SESSION_CONSUMED';

export class SkillRepositoryError extends Error {
  readonly code: SkillRepositoryErrorCode;
  readonly status: number;

  constructor(code: SkillRepositoryErrorCode, message: string, status = 409) {
    super(message);
    this.name = 'SkillRepositoryError';
    this.code = code;
    this.status = status;
  }
}

export type SkillStorageErrorCode =
  | 'BLOB_TOO_LARGE'
  | 'BLOB_WRITE_FAILED'
  | 'BLOB_MISSING'
  | 'BLOB_HASH_MISMATCH'
  | 'RELEASE_HASH_MISMATCH'
  | 'RELEASE_INCOMPLETE'
  | 'RELEASE_RENAME_FAILED'
  | 'STORAGE_UNAVAILABLE'
  | 'INVALID_HASH';

export type SkillSyncErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'SESSION_CONSUMED'
  | 'HASH_MISMATCH'
  | 'PATH_NOT_IN_DIFF'
  | 'NAME_LOCKED'
  | 'DRAFT_REQUIRED';

export class SkillSyncError extends Error {
  readonly code: SkillSyncErrorCode;
  readonly status: number;

  constructor(code: SkillSyncErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'SkillSyncError';
    this.code = code;
    this.status = status ?? defaultSyncStatus(code);
  }
}

function defaultSyncStatus(code: SkillSyncErrorCode): number {
  switch (code) {
    case 'SESSION_NOT_FOUND':
    case 'DRAFT_REQUIRED':
      return 404;
    case 'SESSION_EXPIRED':
      return 410;
    case 'PATH_NOT_IN_DIFF':
      return 400;
    default:
      return 409;
  }
}

export class SkillStorageError extends Error {
  readonly code: SkillStorageErrorCode;
  readonly status: number;

  constructor(code: SkillStorageErrorCode, message: string, status = 503) {
    super(message);
    this.name = 'SkillStorageError';
    this.code = code;
    this.status = status;
  }
}
