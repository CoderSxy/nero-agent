import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { HistoryMetadata, HistoryPoint } from './types';
import { HISTORY_TURN_CONTEXT_PREVIEW } from './types';

const MESSAGES_TABLE = 'mastra_messages';
const THREADS_TABLE = 'mastra_threads';

export type HistoryScope = { userId: string; threadId: string };

export type HistoryThreadRow = {
  id: string;
  resourceId: string;
  metadata?: unknown;
  updatedAt: string;
};

export type HistoryMessageRow = {
  id: string;
  role: string;
  type?: string;
  createdAt: string;
  threadId: string;
  resourceId: string;
  content: unknown;
};

export type ReadMetadataOptions = {
  before?: HistoryPoint;
  after?: HistoryPoint;
  upper: HistoryPoint;
  limit: number;
  /** ASC when true (after-page); default DESC for latest/before scans. */
  ascending?: boolean;
};

export type TurnContextResult = {
  messageId: string;
  preview: string;
  point: HistoryPoint;
} | null;

export type HistoryRepository = {
  withReadTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  getThread(scope: HistoryScope, client?: PoolClient): Promise<HistoryThreadRow | null>;
  getUpper(scope: HistoryScope, client?: PoolClient): Promise<HistoryPoint | null>;
  readMetadata(
    scope: HistoryScope,
    options: ReadMetadataOptions,
    client?: PoolClient,
  ): Promise<HistoryMetadata[]>;
  readMessages(scope: HistoryScope, ids: string[], client?: PoolClient): Promise<HistoryMessageRow[]>;
  findTarget(
    scope: HistoryScope,
    messageId: string,
    client?: PoolClient,
  ): Promise<(HistoryPoint & { threadId: string; resourceId: string }) | null>;
  findTurnContext(
    scope: HistoryScope,
    point: HistoryPoint,
    scanLimit: number,
    client?: PoolClient,
  ): Promise<TurnContextResult>;
};

type Queryable = Pool | PoolClient;

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Preserve DB timestamp text; never round-trip through JS Date. */
const CREATED_AT_TEXT = `${quoteIdent('createdAt')}::text`;

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

function parseContent(raw: unknown): unknown {
  if (raw == null) return raw;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractSignalType(content: unknown): string | undefined {
  const parsed = parseContent(content);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const metadata = (parsed as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const signal = (metadata as { signal?: unknown }).signal;
  if (!signal || typeof signal !== 'object') return undefined;
  const type = (signal as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

function contentBytesOf(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (Buffer.isBuffer(content)) return content.byteLength;
  try {
    return Buffer.byteLength(JSON.stringify(content), 'utf8');
  } catch {
    return Buffer.byteLength(String(content), 'utf8');
  }
}

function isUserMeta(role: string, type: string | undefined, signalType: string | undefined): boolean {
  if (role === 'user') return true;
  if (role !== 'signal') return false;
  const resolved = signalType ?? type;
  return resolved === 'user' || resolved === 'user-message';
}

function mapMetadataRow(row: QueryResultRow): HistoryMetadata {
  const content = row.content;
  const signalType = typeof row.signalType === 'string' ? row.signalType : extractSignalType(content);
  return {
    id: String(row.id),
    createdAt: asText(row.createdAt),
    role: String(row.role),
    ...(row.type != null && row.type !== 'v2' ? { type: String(row.type) } : {}),
    ...(signalType !== undefined ? { signalType } : {}),
    contentBytes: Number(row.contentBytes ?? contentBytesOf(content)),
  };
}

/** Normalize like @mastra/pg MemoryPG.parseRow without importing private helpers. */
export function normalizeHistoryMessageRow(row: QueryResultRow): HistoryMessageRow {
  const content = parseContent(row.content);
  return {
    id: String(row.id),
    role: String(row.role),
    ...(row.type != null && row.type !== 'v2' ? { type: String(row.type) } : {}),
    createdAt: asText(row.createdAtZ ?? row.createdAt),
    threadId: String(row.threadId ?? row.thread_id),
    resourceId: String(row.resourceId),
    content,
  };
}

export function createHistoryRepository(pool: Pool): HistoryRepository {
  async function withClient<T>(
    client: PoolClient | undefined,
    fn: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (client) return fn(client);
    const acquired = await pool.connect();
    try {
      return await fn(acquired);
    } finally {
      acquired.release();
    }
  }

  return {
    async withReadTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      } finally {
        client.release();
      }
    },

    async getThread(scope, client) {
      return withClient(client, async (c) => {
        const result = await c.query(
          `SELECT id, ${quoteIdent('resourceId')} AS "resourceId", metadata,
                  COALESCE(${quoteIdent('updatedAtZ')}::text, ${quoteIdent('updatedAt')}::text) AS "updatedAt"
           FROM ${THREADS_TABLE}
           WHERE id = $1 AND ${quoteIdent('resourceId')} = $2`,
          [scope.threadId, scope.userId],
        );
        const row = result.rows[0];
        if (!row) return null;
        return {
          id: String(row.id),
          resourceId: String(row.resourceId),
          metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
          updatedAt: asText(row.updatedAt),
        };
      });
    },

    async getUpper(scope, client) {
      return withClient(client, async (c) => {
        const result = await c.query(
          `SELECT id, ${CREATED_AT_TEXT} AS "createdAt"
           FROM ${MESSAGES_TABLE}
           WHERE thread_id = $1 AND ${quoteIdent('resourceId')} = $2
           ORDER BY ${quoteIdent('createdAt')} DESC, id DESC
           LIMIT 1`,
          [scope.threadId, scope.userId],
        );
        const row = result.rows[0];
        if (!row) return null;
        return { id: String(row.id), createdAt: asText(row.createdAt) };
      });
    },

    async readMetadata(scope, options, client) {
      return withClient(client, async (c) => {
        const params: unknown[] = [scope.threadId, scope.userId, options.upper.createdAt, options.upper.id];
        let where = `thread_id = $1 AND ${quoteIdent('resourceId')} = $2
          AND (${quoteIdent('createdAt')}, id) <= ($3::timestamp, $4)`;

        if (options.before) {
          params.push(options.before.createdAt, options.before.id);
          where += ` AND (${quoteIdent('createdAt')}, id) < ($${params.length - 1}::timestamp, $${params.length})`;
        }
        if (options.after) {
          params.push(options.after.createdAt, options.after.id);
          where += ` AND (${quoteIdent('createdAt')}, id) > ($${params.length - 1}::timestamp, $${params.length})`;
        }

        params.push(options.limit);
        const order = options.ascending
          ? `${quoteIdent('createdAt')} ASC, id ASC`
          : `${quoteIdent('createdAt')} DESC, id DESC`;

        const result = await c.query(
          `SELECT id, role, type, ${CREATED_AT_TEXT} AS "createdAt",
                  CASE WHEN role = 'signal' AND content IS JSON OBJECT
                    THEN content::jsonb #>> '{metadata,signal,type}' END AS "signalType",
                  octet_length(COALESCE(content::text, '')) AS "contentBytes"
           FROM ${MESSAGES_TABLE}
           WHERE ${where}
           ORDER BY ${order}
           LIMIT $${params.length}`,
          params,
        );
        const rows = result.rows.map(mapMetadataRow);
        return options.ascending ? rows : rows.reverse();
      });
    },

    async readMessages(scope, ids, client) {
      if (ids.length === 0) return [];
      return withClient(client, async (c) => {
        const result = await c.query(
          `SELECT id, content, role, type, ${CREATED_AT_TEXT} AS "createdAt",
                  COALESCE(${quoteIdent('createdAtZ')}::text, ${CREATED_AT_TEXT}) AS "createdAtZ",
                  thread_id AS "threadId", ${quoteIdent('resourceId')} AS "resourceId"
           FROM ${MESSAGES_TABLE}
           WHERE thread_id = $1 AND ${quoteIdent('resourceId')} = $2
             AND id = ANY($3::text[])`,
          [scope.threadId, scope.userId, ids],
        );
        const byId = new Map(result.rows.map((row) => [String(row.id), normalizeHistoryMessageRow(row)]));
        return ids.map((id) => byId.get(id)).filter((row): row is HistoryMessageRow => Boolean(row));
      });
    },

    async findTarget(scope, messageId, client) {
      return withClient(client, async (c) => {
        const result = await c.query(
          `SELECT id, ${CREATED_AT_TEXT} AS "createdAt", thread_id AS "threadId",
                  ${quoteIdent('resourceId')} AS "resourceId"
           FROM ${MESSAGES_TABLE}
           WHERE id = $1`,
          [messageId],
        );
        const row = result.rows[0];
        if (!row) return null;
        if (String(row.threadId) !== scope.threadId || String(row.resourceId) !== scope.userId) {
          return null;
        }
        return {
          id: String(row.id),
          createdAt: asText(row.createdAt),
          threadId: String(row.threadId),
          resourceId: String(row.resourceId),
        };
      });
    },

    async findTurnContext(scope, point, scanLimit, client) {
      return withClient(client, async (c) => {
        const rows = await this.readMetadata(scope, { upper: point, limit: Math.max(1, scanLimit) }, c);
        for (const meta of rows.reverse()) {
          if (!isUserMeta(meta.role, meta.type, meta.signalType)) continue;
          const result = await c.query(
            `SELECT CASE WHEN content IS JSON OBJECT THEN
               left(COALESCE((SELECT string_agg(part->>'text', '' ORDER BY ord)
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(content::jsonb->'parts') = 'array'
                   THEN content::jsonb->'parts' ELSE '[]'::jsonb END) WITH ORDINALITY AS p(part, ord)), ''), $4)
             WHEN content IS JSON SCALAR THEN left(content::jsonb #>> '{}', $4)
             ELSE left(content, $4) END AS preview
             FROM ${MESSAGES_TABLE} WHERE id=$1 AND thread_id=$2 AND "resourceId"=$3`,
            [meta.id, scope.threadId, scope.userId, HISTORY_TURN_CONTEXT_PREVIEW],
          );
          return {
            messageId: meta.id,
            preview: String(result.rows[0]?.preview ?? ''),
            point: { id: meta.id, createdAt: meta.createdAt },
          };
        }
        return null;
      });
    },
  };
}

/** @internal exported for tests that need SQL shape inspection without a pool. */
export const historyRepositorySql = {
  messagesTable: MESSAGES_TABLE,
  threadsTable: THREADS_TABLE,
  createdAtText: CREATED_AT_TEXT,
};
