import type { Pool, PoolClient } from 'pg';
import { getPool } from '../auth/db';
import type { ApiMode, ModelScope } from './types';

export type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Server-only record. Contains ciphertext and must never be serialized to clients. */
export type ModelRecord = {
  id: string;
  scope: ModelScope;
  userId: string | null;
  displayName: string;
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiMode: ApiMode;
  apiKeyCiphertext: string;
  enabled: boolean;
  supportsVision: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ModelColumns = {
  displayName: string;
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiMode: ApiMode;
  apiKeyCiphertext: string;
  enabled: boolean;
  supportsVision: boolean;
  isDefault: boolean;
};

type ModelRow = {
  id: string;
  user_id: string | null;
  display_name: string;
  provider_id: string;
  model_id: string;
  base_url: string;
  api_mode: ApiMode;
  api_key_ciphertext: string;
  enabled: boolean;
  supports_vision: boolean;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
};

const TABLES: Record<ModelScope, string> = {
  public: 'app_public_models',
  private: 'app_private_models',
};

const SELECT_COLUMNS: Record<ModelScope, string> = {
  public: `id, NULL::uuid AS user_id, display_name, provider_id, model_id, base_url, api_mode,
    api_key_ciphertext, enabled, supports_vision, is_default, created_at, updated_at`,
  private: `id, user_id, display_name, provider_id, model_id, base_url, api_mode,
    api_key_ciphertext, enabled, supports_vision, false AS is_default, created_at, updated_at`,
};

const COLUMN_NAMES: Record<keyof Omit<ModelColumns, 'isDefault'>, string> = {
  displayName: 'display_name',
  providerId: 'provider_id',
  modelId: 'model_id',
  baseUrl: 'base_url',
  apiMode: 'api_mode',
  apiKeyCiphertext: 'api_key_ciphertext',
  enabled: 'enabled',
  supportsVision: 'supports_vision',
};

function toRecord(scope: ModelScope, row: ModelRow): ModelRecord {
  return {
    id: row.id,
    scope,
    userId: row.user_id,
    displayName: row.display_name,
    providerId: row.provider_id,
    modelId: row.model_id,
    baseUrl: row.base_url,
    apiMode: row.api_mode,
    apiKeyCiphertext: row.api_key_ciphertext,
    enabled: row.enabled,
    supportsVision: row.supports_vision,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function lockPublicDefault(db: Queryable): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('app_public_models_default'))`);
}

export async function clearPublicDefault(db: Queryable, exceptId?: string): Promise<void> {
  await db.query(
    'UPDATE app_public_models SET is_default = false, updated_at = now() WHERE is_default AND ($1::uuid IS NULL OR id <> $1::uuid)',
    [exceptId ?? null],
  );
}

export async function listEnabledPublic(db: Queryable = getPool()): Promise<ModelRecord[]> {
  const result = await db.query<ModelRow>(
    `SELECT ${SELECT_COLUMNS.public} FROM ${TABLES.public} WHERE enabled
     ORDER BY is_default DESC, display_name, created_at, id`,
  );
  return result.rows.map((row) => toRecord('public', row));
}

export async function listAllPublic(db: Queryable = getPool()): Promise<ModelRecord[]> {
  const result = await db.query<ModelRow>(
    `SELECT ${SELECT_COLUMNS.public} FROM ${TABLES.public}
     ORDER BY is_default DESC, display_name, created_at, id`,
  );
  return result.rows.map((row) => toRecord('public', row));
}

export async function listPrivateForUser(
  userId: string,
  options: { enabledOnly: boolean },
  db: Queryable = getPool(),
): Promise<ModelRecord[]> {
  const result = await db.query<ModelRow>(
    `SELECT ${SELECT_COLUMNS.private} FROM ${TABLES.private}
     WHERE user_id = $1 AND ($2::boolean = false OR enabled)
     ORDER BY display_name, created_at, id`,
    [userId, options.enabledOnly],
  );
  return result.rows.map((row) => toRecord('private', row));
}

/** Private lookups always carry the owner predicate; public lookups take no user id. */
export async function findRecord(
  scope: ModelScope,
  id: string,
  ownerId: string | null,
  db: Queryable = getPool(),
  forUpdate = false,
): Promise<ModelRecord | null> {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  const result =
    scope === 'public'
      ? await db.query<ModelRow>(
          `SELECT ${SELECT_COLUMNS.public} FROM ${TABLES.public} WHERE id = $1${lock}`,
          [id],
        )
      : await db.query<ModelRow>(
          `SELECT ${SELECT_COLUMNS.private} FROM ${TABLES.private} WHERE id = $1 AND user_id = $2${lock}`,
          [id, ownerId],
        );
  return result.rows[0] ? toRecord(scope, result.rows[0]) : null;
}

export async function insertRecord(
  scope: ModelScope,
  ownerId: string | null,
  columns: ModelColumns,
  db: Queryable = getPool(),
): Promise<ModelRecord> {
  const result =
    scope === 'public'
      ? await db.query<ModelRow>(
          `INSERT INTO ${TABLES.public}
             (display_name, provider_id, model_id, base_url, api_mode, api_key_ciphertext, enabled,
              supports_vision, is_default)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING ${SELECT_COLUMNS.public}`,
          [
            columns.displayName, columns.providerId, columns.modelId, columns.baseUrl,
            columns.apiMode, columns.apiKeyCiphertext, columns.enabled, columns.supportsVision,
            columns.isDefault,
          ],
        )
      : await db.query<ModelRow>(
          `INSERT INTO ${TABLES.private}
             (user_id, display_name, provider_id, model_id, base_url, api_mode, api_key_ciphertext,
              enabled, supports_vision)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING ${SELECT_COLUMNS.private}`,
          [
            ownerId, columns.displayName, columns.providerId, columns.modelId, columns.baseUrl,
            columns.apiMode, columns.apiKeyCiphertext, columns.enabled, columns.supportsVision,
          ],
        );
  return toRecord(scope, result.rows[0]);
}

export async function updateRecord(
  scope: ModelScope,
  id: string,
  ownerId: string | null,
  changes: Partial<ModelColumns>,
  db: Queryable = getPool(),
): Promise<ModelRecord | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(COLUMN_NAMES)) {
    const value = changes[key as keyof typeof COLUMN_NAMES];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }
  if (scope === 'public' && changes.isDefault !== undefined) {
    values.push(changes.isDefault);
    assignments.push(`is_default = $${values.length}`);
  }
  assignments.push('updated_at = now()');

  values.push(id);
  const idParam = `$${values.length}`;
  let where = `id = ${idParam}`;
  if (scope === 'private') {
    values.push(ownerId);
    where += ` AND user_id = $${values.length}`;
  }

  const result = await db.query<ModelRow>(
    `UPDATE ${TABLES[scope]} SET ${assignments.join(', ')} WHERE ${where}
     RETURNING ${SELECT_COLUMNS[scope]}`,
    values,
  );
  return result.rows[0] ? toRecord(scope, result.rows[0]) : null;
}

export async function deleteRecord(
  scope: ModelScope,
  id: string,
  ownerId: string | null,
  db: Queryable = getPool(),
): Promise<boolean> {
  const result =
    scope === 'public'
      ? await db.query(`DELETE FROM ${TABLES.public} WHERE id = $1`, [id])
      : await db.query(`DELETE FROM ${TABLES.private} WHERE id = $1 AND user_id = $2`, [id, ownerId]);
  return (result.rowCount ?? 0) > 0;
}

export async function findEnabledPublicByProviderModel(
  providerId: string,
  modelId: string,
  db: Queryable = getPool(),
): Promise<ModelRecord[]> {
  const result = await db.query<ModelRow>(
    `SELECT ${SELECT_COLUMNS.public} FROM ${TABLES.public}
     WHERE enabled AND provider_id = $1 AND model_id = $2
     ORDER BY created_at, id LIMIT 2`,
    [providerId, modelId],
  );
  return result.rows.map((row) => toRecord('public', row));
}
