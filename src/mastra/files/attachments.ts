import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/auth-context';
import { assertThreadOwned, ThreadGuardError, type ThreadLookup } from '../auth/thread-guard';
import { ensureUserWorkspace } from '../workspace/manager';
import { assertContained } from '../workspace/path';
import { FilePathError, relativeFilePath } from './policy';
import { FileServiceError } from './service';
import { readWorkspaceVersion } from './workspace-editor';

export const MAX_MESSAGE_ATTACHMENTS = 10;
const STALE_PENDING_MS = 24 * 60 * 60 * 1000;

export type AttachmentSource = 'personal' | 'agent';
export type AttachmentStatus = 'available' | 'changed' | 'deleted';

export type AttachmentItem = { source: AttachmentSource; path: string };

export type AttachmentRef = {
  attachmentId: string;
  clientMessageId: string;
  source: AttachmentSource;
  path: string;
  name: string;
  size: number;
  mimeType: string;
  etag: string;
  status: AttachmentStatus;
};

export type MessagePersistenceLookup = {
  hasPersistedClientMessage(args: {
    threadId: string;
    resourceId: string;
    clientMessageId: string;
  }): Promise<boolean>;
};

type StoredRef = {
  attachmentId: string;
  ownerId: string;
  threadId: string;
  clientMessageId: string;
  source: AttachmentSource;
  path: string;
  name: string;
  size: number;
  mimeType: string;
  etag: string;
  createdAt: Date;
};

type AgentWorkspaceResolver = () => Promise<{ filesystem: { basePath?: string } } | undefined>;

const memoryStore: StoredRef[] = [];

export class AttachmentService {
  constructor(
    private readonly lookup: ThreadLookup,
    private readonly options: {
      resolveAgentWorkspace?: AgentWorkspaceResolver;
      messageLookup?: MessagePersistenceLookup;
      clock?: () => Date;
    } = {},
  ) {}

  private now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  async prepare(
    auth: AuthContext,
    threadId: string,
    clientMessageId: string,
    items: AttachmentItem[],
  ): Promise<AttachmentRef[]> {
    await assertThreadOwned(auth, threadId, this.lookup);
    const messageId = normalizeClientMessageId(clientMessageId);
    const unique = dedupeItems(items);
    if (unique.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new FileServiceError(400, '单条消息最多 10 个附件');
    }
    const inspected = [];
    for (const item of unique) {
      inspected.push({ item, file: await this.inspectExistingFile(auth, item.source, item.path) });
    }
    const existing = await this.loadForMessage(auth.userId, threadId, messageId);
    const existingKeys = new Set(existing.map(record => `${record.source}\0${record.path}`));
    const additions = inspected.filter(({ item }) => !existingKeys.has(itemKey(item)));
    if (existing.length + additions.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new FileServiceError(400, '单条消息最多 10 个附件');
    }
    const created: StoredRef[] = [];
    for (const { item, file } of additions) {
      created.push(await this.insert({
        attachmentId: randomUUID(),
        ownerId: auth.userId,
        threadId,
        clientMessageId: messageId,
        source: item.source,
        path: item.path,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        etag: file.etag,
        createdAt: this.now(),
      }));
    }
    const byKey = new Map(
      [...existing, ...created].map(record => [`${record.source}\0${record.path}`, record] as const),
    );
    return Promise.all(unique.map(async item => this.toRef(byKey.get(itemKey(item))!)));
  }

  async listForThread(auth: AuthContext, threadId: string): Promise<AttachmentRef[]> {
    await assertThreadOwned(auth, threadId, this.lookup);
    const records = await this.loadForThread(auth.userId, threadId);
    return Promise.all(records.map(record => this.toRef(record)));
  }

  async readOwned(
    auth: AuthContext,
    threadId: string,
    attachmentId: string,
  ): Promise<{ ref: AttachmentRef; data: Buffer }> {
    await assertThreadOwned(auth, threadId, this.lookup);
    const record = await this.loadById(attachmentId);
    if (!record) throw new FileServiceError(404, '附件不存在');
    if (record.ownerId !== auth.userId || record.threadId !== threadId) {
      throw new ThreadGuardError(403, 'Access denied: thread belongs to a different resource');
    }
    const live = await this.liveFile(auth, record);
    const ref = this.refFrom(record, live.status);
    if (live.status === 'deleted' || !live.data) return { ref, data: Buffer.alloc(0) };
    return { ref, data: live.data };
  }

  async cleanupStalePending(options: { now?: Date } = {}): Promise<number> {
    const lookup = this.options.messageLookup;
    if (!lookup) return 0;
    const now = options.now ?? this.now();
    const cutoff = new Date(now.getTime() - STALE_PENDING_MS);
    const groups = await this.loadStaleGroups(cutoff);
    let removed = 0;
    for (const group of groups) {
      let persisted: boolean;
      try {
        persisted = await lookup.hasPersistedClientMessage({
          threadId: group.threadId,
          resourceId: group.ownerId,
          clientMessageId: group.clientMessageId,
        });
      } catch {
        continue;
      }
      if (persisted) continue;
      removed += await this.deleteExpiredMessageRefs(
        group.ownerId, group.threadId, group.clientMessageId, cutoff,
      );
    }
    return removed;
  }

  private async inspectExistingFile(auth: AuthContext, source: AttachmentSource, path: string) {
    if (source !== 'personal' && source !== 'agent') throw new FilePathError('工作区来源无效');
    if (source === 'agent' && !auth.roles.includes('admin')) {
      throw new FileServiceError(403, '无权访问工作区');
    }
    const rel = relativeFilePath(path);
    const root = await this.workspaceRoot(auth, source);
    const hostPath = join(root, rel);
    try {
      assertContained(root, hostPath);
    } catch {
      throw new FilePathError();
    }
    let info;
    try {
      info = await lstat(hostPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileServiceError(404, '文件不存在');
      throw error;
    }
    if (info.isSymbolicLink() || info.isDirectory() || !info.isFile()) throw new FilePathError();
    const real = await realpath(hostPath);
    try {
      assertContained(root, real);
    } catch {
      throw new FilePathError();
    }
    const data = await readFile(real);
    return {
      name: rel.split('/').at(-1) ?? rel,
      size: data.byteLength,
      mimeType: mimeFromName(rel),
      etag: readWorkspaceVersion(data),
      hostPath: real,
      data,
    };
  }

  private async workspaceRoot(auth: AuthContext, source: AttachmentSource): Promise<string> {
    if (source === 'personal') return realpath(await ensureUserWorkspace(auth));
    const workspace = await this.options.resolveAgentWorkspace?.();
    if (!workspace?.filesystem.basePath) throw new FileServiceError(404, '当前用户没有可浏览的工作区');
    return realpath(workspace.filesystem.basePath);
  }

  private async liveFile(auth: AuthContext, record: StoredRef) {
    try {
      const file = await this.inspectExistingFile(auth, record.source, record.path);
      return {
        status: (file.etag === record.etag ? 'available' : 'changed') as AttachmentStatus,
        data: file.data,
      };
    } catch (error) {
      if (error instanceof FileServiceError && error.status === 404) {
        return { status: 'deleted' as const, data: undefined };
      }
      if (error instanceof FilePathError) return { status: 'deleted' as const, data: undefined };
      throw error;
    }
  }

  private async toRef(record: StoredRef): Promise<AttachmentRef> {
    const live = await this.liveFile(
      { userId: record.ownerId, roles: record.source === 'agent' ? ['admin'] : ['user'] },
      record,
    );
    return this.refFrom(record, live.status);
  }

  private refFrom(record: StoredRef, status: AttachmentStatus): AttachmentRef {
    return {
      attachmentId: record.attachmentId,
      clientMessageId: record.clientMessageId,
      source: record.source,
      path: record.path,
      name: record.name,
      size: Number(record.size),
      mimeType: record.mimeType,
      etag: record.etag,
      status,
    };
  }

  private usesDatabase(): boolean {
    return Boolean(process.env.DATABASE_URL);
  }

  private async insert(record: StoredRef): Promise<StoredRef> {
    if (!this.usesDatabase()) {
      const found = memoryStore.find(item => keyOf(item) === keyOf(record));
      if (found) return found;
      memoryStore.push(record);
      return record;
    }
    const { getPool } = await import('../auth/db');
    const inserted = await getPool().query(
      `INSERT INTO app_attachment_refs
        (id, owner_id, thread_id, client_message_id, source, path, name, size, mime_type, etag, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (owner_id, thread_id, client_message_id, source, path) DO NOTHING
       RETURNING id, owner_id, thread_id, client_message_id, source, path, name, size, mime_type, etag, created_at`,
      [
        record.attachmentId, record.ownerId, record.threadId, record.clientMessageId, record.source,
        record.path, record.name, record.size, record.mimeType, record.etag, record.createdAt,
      ],
    );
    if (inserted.rowCount) return fromRow(inserted.rows[0]);
    const existing = await getPool().query(
      `SELECT id, owner_id, thread_id, client_message_id, source, path, name, size, mime_type, etag, created_at
       FROM app_attachment_refs
       WHERE owner_id = $1 AND thread_id = $2 AND client_message_id = $3 AND source = $4 AND path = $5`,
      [record.ownerId, record.threadId, record.clientMessageId, record.source, record.path],
    );
    return fromRow(existing.rows[0]);
  }

  private async loadById(id: string): Promise<StoredRef | undefined> {
    if (!this.usesDatabase()) return memoryStore.find(item => item.attachmentId === id);
    const { getPool } = await import('../auth/db');
    const result = await getPool().query(
      `SELECT id, owner_id, thread_id, client_message_id, source, path, name, size, mime_type, etag, created_at
       FROM app_attachment_refs WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  private async loadForMessage(ownerId: string, threadId: string, clientMessageId: string) {
    if (!this.usesDatabase()) {
      return memoryStore.filter(item =>
        item.ownerId === ownerId && item.threadId === threadId && item.clientMessageId === clientMessageId);
    }
    const { getPool } = await import('../auth/db');
    const result = await getPool().query(
      `SELECT id, owner_id, thread_id, client_message_id, source, path, name, size, mime_type, etag, created_at
       FROM app_attachment_refs
       WHERE owner_id = $1 AND thread_id = $2 AND client_message_id = $3
       ORDER BY created_at ASC`,
      [ownerId, threadId, clientMessageId],
    );
    return result.rows.map(fromRow);
  }

  private async loadForThread(ownerId: string, threadId: string) {
    if (!this.usesDatabase()) {
      return memoryStore.filter(item => item.ownerId === ownerId && item.threadId === threadId);
    }
    const { getPool } = await import('../auth/db');
    const result = await getPool().query(
      `SELECT id, owner_id, thread_id, client_message_id, source, path, name, size, mime_type, etag, created_at
       FROM app_attachment_refs WHERE owner_id = $1 AND thread_id = $2 ORDER BY created_at ASC`,
      [ownerId, threadId],
    );
    return result.rows.map(fromRow);
  }

  private async loadStaleGroups(cutoff: Date) {
    if (!this.usesDatabase()) {
      const groups = new Map<string, { ownerId: string; threadId: string; clientMessageId: string }>();
      for (const item of memoryStore) {
        if (item.createdAt > cutoff) continue;
        groups.set(`${item.ownerId}\0${item.threadId}\0${item.clientMessageId}`, {
          ownerId: item.ownerId, threadId: item.threadId, clientMessageId: item.clientMessageId,
        });
      }
      return [...groups.values()];
    }
    const { getPool } = await import('../auth/db');
    const result = await getPool().query(
      `SELECT owner_id, thread_id, client_message_id
       FROM app_attachment_refs
       WHERE created_at <= $1
       GROUP BY owner_id, thread_id, client_message_id`,
      [cutoff],
    );
    return result.rows.map(row => ({
      ownerId: row.owner_id as string,
      threadId: row.thread_id as string,
      clientMessageId: row.client_message_id as string,
    }));
  }

  private async deleteExpiredMessageRefs(
    ownerId: string,
    threadId: string,
    clientMessageId: string,
    cutoff: Date,
  ) {
    if (!this.usesDatabase()) {
      let count = 0;
      for (let index = memoryStore.length - 1; index >= 0; index -= 1) {
        const item = memoryStore[index]!;
        if (
          item.ownerId === ownerId
          && item.threadId === threadId
          && item.clientMessageId === clientMessageId
          && item.createdAt <= cutoff
        ) {
          memoryStore.splice(index, 1);
          count += 1;
        }
      }
      return count;
    }
    const { getPool } = await import('../auth/db');
    const result = await getPool().query(
      `DELETE FROM app_attachment_refs
       WHERE owner_id = $1 AND thread_id = $2 AND client_message_id = $3 AND created_at <= $4`,
      [ownerId, threadId, clientMessageId, cutoff],
    );
    return result.rowCount ?? 0;
  }
}

function normalizeClientMessageId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 256) {
    throw new FileServiceError(400, '消息 ID 无效');
  }
  return value.trim();
}

function dedupeItems(items: AttachmentItem[]): AttachmentItem[] {
  const seen = new Set<string>();
  const unique: AttachmentItem[] = [];
  for (const item of items ?? []) {
    if (!item || (item.source !== 'personal' && item.source !== 'agent')) {
      throw new FilePathError('工作区来源无效');
    }
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function itemKey(item: AttachmentItem): string {
  return `${item.source}\0${item.path}`;
}

function keyOf(record: Pick<StoredRef, 'ownerId' | 'threadId' | 'clientMessageId' | 'source' | 'path'>): string {
  return `${record.ownerId}\0${record.threadId}\0${record.clientMessageId}\0${record.source}\0${record.path}`;
}

function mimeFromName(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
  };
  return types[ext ?? ''] ?? 'application/octet-stream';
}

function fromRow(row: Record<string, unknown>): StoredRef {
  return {
    attachmentId: String(row.id),
    ownerId: String(row.owner_id),
    threadId: String(row.thread_id),
    clientMessageId: String(row.client_message_id),
    source: row.source as AttachmentSource,
    path: String(row.path),
    name: String(row.name),
    size: Number(row.size),
    mimeType: String(row.mime_type),
    etag: String(row.etag),
    createdAt: new Date(String(row.created_at)),
  };
}

type RecallMessage = { id: string; content?: { metadata?: Record<string, unknown> } };

type RecallArgs = {
  threadId: string;
  resourceId?: string;
  page?: number;
  perPage?: number | false;
  includeTotal?: boolean;
  include?: Array<{ id: string }>;
  filter?: { metadata?: Record<string, string | number | boolean | null> };
};

type RecallResult = {
  messages: RecallMessage[];
  hasMore?: boolean;
  page?: number;
  perPage?: number | false;
};

const RECALL_PAGE_SIZE = 100;
const RECALL_MAX_PAGES = 1000;

function messageMatchesClientId(message: RecallMessage, clientMessageId: string): boolean {
  return message.id === clientMessageId
    || message.content?.metadata?.clientMessageId === clientMessageId;
}

export function messageLookupFromRecall(
  recall: (args: RecallArgs) => Promise<RecallResult>,
): MessagePersistenceLookup {
  return {
    async hasPersistedClientMessage({ threadId, resourceId, clientMessageId }) {
      try {
        const exact = await recall({
          threadId,
          resourceId,
          include: [{ id: clientMessageId }],
          perPage: 1,
          includeTotal: false,
        });
        if (exact.messages.some(message => messageMatchesClientId(message, clientMessageId))) {
          return true;
        }
      } catch {
        // Exact include is unavailable; fall through to exhaustive paging.
      }
      try {
        const byMeta = await recall({
          threadId,
          resourceId,
          filter: { metadata: { clientMessageId } },
          perPage: 1,
          includeTotal: false,
        });
        if (byMeta.messages.some(message => messageMatchesClientId(message, clientMessageId))) {
          return true;
        }
      } catch {
        // Metadata filter is unavailable; fall through to exhaustive paging.
      }
      try {
        for (let page = 0; page < RECALL_MAX_PAGES; page += 1) {
          const result = await recall({
            threadId,
            resourceId,
            page,
            perPage: RECALL_PAGE_SIZE,
            includeTotal: false,
          });
          if (result.messages.some(message => messageMatchesClientId(message, clientMessageId))) {
            return true;
          }
          const pageSize = typeof result.perPage === 'number' ? result.perPage : RECALL_PAGE_SIZE;
          const exhausted = result.hasMore === false
            || (result.hasMore !== true && result.messages.length < pageSize);
          if (exhausted) return false;
          if (result.hasMore !== true && result.messages.length === 0) return false;
        }
      } catch {
        return true;
      }
      return true;
    },
  };
}
