import { getSandboxRuntimeConfig } from '../sandbox/runtime-config';
import type { Pool, PoolClient } from 'pg';
import { Readable } from 'node:stream';
import { withSkillStorageReadLock } from './storage-lock';
import { parseRuntimeManifest } from './package';
import { getPool } from '../auth/db';
import { getActiveUserById } from '../auth/service';
import type { BlobStore } from './blob-store';
import {
  assertCanEdit,
  assertCanManage,
  assertCanUse,
  assertCanViewDraft,
  evaluateSkillPermissions,
  SkillPolicyError,
  skillRecordToPermissionSkill,
  unavailable,
  type SkillCapabilities,
} from './policy';
import type { ReleaseStore } from './release-store';
import type { SkillAccessSnapshot, SkillRepository } from './repository';
import type {
  CreateDraftServiceInput,
  CreateWorkingDraftServiceInput,
  DeleteDraftFileServiceInput,
  DeleteSkillServiceInput,
  DeleteVersionServiceInput,
  PublishSkillInput,
  RollbackSkillInput,
  SaveDraftServiceInput,
  SaveFileServiceInput,
  SetEnabledServiceInput,
  SetMetadataServiceInput,
  SkillActivation,
  SkillActor,
  SkillAudienceRecord,
  SkillEventRecord,
  SkillExecutionContext,
  SkillFileDownload,
  SkillFileRecord,
  SkillGroupRecord,
  SkillListPage,
  SkillManageDetail,
  SkillManageListItem,
  SkillPageQuery,
  SkillPin,
  SkillPublishResult,
  SkillReadInput,
  SkillRecord,
  SkillResourceGroup,
  SkillResourceSummary,
  SkillResult,
  SkillSearchHit,
  SkillSearchInput,
  SkillSearchPage,
  SkillSummary,
  SkillText,
  SkillUserPickerItem,
  SkillVersionRecord,
  SkillVersionSummary,
} from './types';
import { reportSkillRuntimeCompatibility } from './runtime';
import { createSkillSyncApi, type CommitImportInput, type CommitSyncInput } from './sync';
import {
  createSkillShortcutStore,
  validateShortcut,
  type ShortcutConfig,
  type ShortcutDb,
  type SkillShortcutAvailable,
  type SkillShortcutRecord,
} from './shortcuts';
import {
  isCanonicalSkillName,
  looksLikeText,
  normalizeSkillPath,
  SKILL_LIMITS,
} from './validation';
import {
  deleteSkillVersion,
  deriveWorkingDraft,
  publishSkill,
  rollbackSkill,
  type SkillVersionService,
} from './versions';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

export type SkillServiceDeps = {
  registeredToolIds?: (actor:SkillActor)=>Iterable<string>;
  repository: SkillRepository;
  blobStore: BlobStore;
  releaseStore: ReleaseStore;
  versionService: SkillVersionService;
  pool?: Pool;
  /** Override for tests; default uses getActiveUserById. */
  isActorActive?: (userId: string) => Promise<boolean>;
};

export type SkillService = {
  listAvailable: (
    actor: SkillActor,
    query: SkillPageQuery,
  ) => Promise<SkillListPage<SkillSummary>>;
  listManageable: (
    actor: SkillActor,
    query: SkillPageQuery,
  ) => Promise<SkillListPage<SkillManageListItem>>;
  load: (ctx: SkillExecutionContext, name: string) => Promise<SkillResult<SkillActivation>>;
  /** Load by skill UUID (explicit selection intent). */
  loadById: (ctx: SkillExecutionContext, skillId: string) => Promise<SkillResult<SkillActivation>>;
  read: (ctx: SkillExecutionContext, input: SkillReadInput) => Promise<SkillResult<SkillText>>;
  search: (
    ctx: SkillExecutionContext,
    input: SkillSearchInput,
  ) => Promise<SkillResult<SkillSearchPage>>;
  createDraft: (
    actor: SkillActor,
    input: CreateDraftServiceInput,
  ) => Promise<{ skill: SkillRecord; version: SkillVersionRecord }>;
  createWorkingDraft: (
    actor: SkillActor,
    input: CreateWorkingDraftServiceInput,
  ) => Promise<{ skill: SkillRecord; version: SkillVersionRecord }>;
  getManageDetail: (actor: SkillActor, id: string) => Promise<SkillManageDetail>;
  saveDraft: (
    actor: SkillActor,
    input: SaveDraftServiceInput,
  ) => Promise<{ skill: SkillRecord; version: SkillVersionRecord }>;
  saveFile: (
    actor: SkillActor,
    input: SaveFileServiceInput,
  ) => Promise<{ skill: SkillRecord; version: SkillVersionRecord }>;
  deleteDraftFile: (
    actor: SkillActor,
    input: DeleteDraftFileServiceInput,
  ) => Promise<{ skill: SkillRecord; version: SkillVersionRecord }>;
  setMetadata: (actor: SkillActor, input: SetMetadataServiceInput) => Promise<SkillRecord>;
  setEnabled: (actor: SkillActor, input: SetEnabledServiceInput) => Promise<SkillRecord>;
  deleteSkill: (actor: SkillActor, input: DeleteSkillServiceInput) => Promise<SkillRecord>;
  listEvents: (
    actor: SkillActor,
    input: { skillId: string } & SkillPageQuery,
  ) => Promise<SkillListPage<SkillEventRecord>>;
  listVersions: (actor: SkillActor, skillId: string) => Promise<SkillVersionSummary[]>;
  deleteVersion: (actor: SkillActor, input: DeleteVersionServiceInput) => Promise<SkillRecord>;
  listFiles: (
    actor: SkillActor,
    skillId: string,
    version: number,
  ) => Promise<SkillFileRecord[]>;
  readFileContent: (
    actor: SkillActor,
    skillId: string,
    version: number,
    path: string,
  ) => Promise<SkillFileDownload>;
  downloadFile: (
    actor: SkillActor,
    skillId: string,
    version: number,
    path: string,
  ) => Promise<SkillFileDownload>;
  exportZip: (
    actor: SkillActor,
    skillId: string,
    version: number,
  ) => Promise<{ bytes: Uint8Array; filename: string }>;
  publish: (actor: SkillActor, input: PublishSkillInput) => Promise<SkillPublishResult>;
  rollback: (actor: SkillActor, input: RollbackSkillInput) => Promise<SkillPublishResult>;
  listGroups: (actor: SkillActor) => Promise<SkillGroupRecord[]>;
  createGroup: (actor: SkillActor, input: { name: string; sort?: number }) => Promise<SkillGroupRecord>;
  updateGroup: (
    actor: SkillActor,
    input: { id: string; name?: string; sort?: number },
  ) => Promise<SkillGroupRecord>;
  deleteGroup: (actor: SkillActor, id: string) => Promise<void>;
  listAudiences: (actor: SkillActor) => Promise<SkillAudienceRecord[]>;
  createAudience: (
    actor: SkillActor,
    input: { name: string; memberIds?: string[] },
  ) => Promise<SkillAudienceRecord>;
  updateAudience: (
    actor: SkillActor,
    input: { id: string; name?: string; memberIds?: string[] },
  ) => Promise<SkillAudienceRecord>;
  deleteAudience: (actor: SkillActor, id: string) => Promise<void>;
  searchUsers: (actor: SkillActor, q: string) => Promise<SkillUserPickerItem[]>;
  previewImport: (
    actor: SkillActor,
    stream: ReadableStream<Uint8Array>,
  ) => ReturnType<ReturnType<typeof createSkillSyncApi>['previewImport']>;
  commitImport: (actor: SkillActor, input: CommitImportInput) => ReturnType<ReturnType<typeof createSkillSyncApi>['commitImport']>;
  previewSync: (
    actor: SkillActor,
    input: { skillId: string; expectedRevision: string; stream: ReadableStream<Uint8Array> },
  ) => ReturnType<ReturnType<typeof createSkillSyncApi>['previewSync']>;
  commitSync: (actor: SkillActor, input: CommitSyncInput) => ReturnType<ReturnType<typeof createSkillSyncApi>['commitSync']>;
  listAvailableShortcuts: (actor: SkillActor) => Promise<{ items: SkillShortcutAvailable[] }>;
  getShortcut: (actor: SkillActor, skillId: string) => Promise<{ shortcut: SkillShortcutRecord | null }>;
  putShortcut: (
    actor: SkillActor,
    input: { skillId: string; expectedRevision: string; config: unknown },
  ) => Promise<{ shortcut: SkillShortcutRecord }>;
};

type CachedBlob = { bytes: Uint8Array; isText: boolean };

function failResult(code: string, message: string): SkillResult<never> {
  return { ok: false, code, message };
}

function unavailableResult(): SkillResult<never> {
  return failResult('SKILL_UNAVAILABLE', 'Skill is unavailable');
}

function splitSkillMd(skillMd: string): { description: string; instructions: string } {
  const match = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { description: '', instructions: skillMd };
  }
  const yaml = match[1] ?? '';
  const body = (match[2] ?? '').replace(/^\uFEFF/, '');
  const descMatch = yaml.match(/^description:\s*(.+)$/m);
  let description = '';
  if (descMatch) {
    description = descMatch[1]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return { description, instructions: body };
}

function resourceGroup(path: string): SkillResourceGroup {
  if (path.startsWith('references/')) return 'references';
  if (path.startsWith('scripts/')) return 'scripts';
  if (path.startsWith('assets/')) return 'assets';
  return 'other';
}

function resolveResourcePath(rawPath: string, pin: SkillPin): string {
  const trimmed = rawPath.trim();
  const baseUri = `skill://${pin.skillId}/${pin.version}/`;
  if (trimmed.startsWith(baseUri)) {
    return normalizeSkillPath(trimmed.slice(baseUri.length) || 'SKILL.md');
  }
  if (trimmed.startsWith('skill://')) {
    const rest = trimmed.slice('skill://'.length);
    const parts = rest.split('/');
    // skill://<id>/<version>/<path...>
    if (parts.length >= 3) {
      return normalizeSkillPath(parts.slice(2).join('/') || 'SKILL.md');
    }
  }
  if (trimmed === 'SKILL.md' || trimmed.toLowerCase() === 'skill.md') {
    return 'SKILL.md';
  }
  return normalizeSkillPath(trimmed);
}

function availabilityFromRuntime(
  runtime: SkillVersionRecord['runtimeManifest'],
  registeredToolIds: Iterable<string> = [],
  scriptTexts?: Record<string, string>,
): SkillActivation['availability'] {
  let publicNetworkAvailable=false;
  try { publicNetworkAvailable=getSandboxRuntimeConfig().networkMode==='public-http'; } catch { /* Invalid deployment is unavailable. */ }
  return reportSkillRuntimeCompatibility(runtime, { registeredToolIds, scriptTexts, publicNetworkAvailable });
}

function sliceTextLines(
  text: string,
  startLine: number,
  endLine: number | undefined,
): SkillText & { path: string } {
  const lines = text.split('\n');
  const start = Number.isFinite(startLine) && startLine >= 1 ? Math.floor(startLine) : 1;
  const maxSpan = SKILL_LIMITS.TEXT_READ_MAX_LINES;
  const defaultSpan = SKILL_LIMITS.TEXT_READ_DEFAULT_LINES;
  let end: number;
  if (endLine != null && Number.isFinite(endLine)) {
    end = Math.floor(endLine);
  } else {
    end = start + defaultSpan - 1;
  }
  if (end < start) end = start;
  if (end - start + 1 > maxSpan) {
    end = start + maxSpan - 1;
  }

  let chunkLines = lines.slice(start - 1, end);
  let truncated = false;
  let encoded = chunkLines.join('\n');
  while (
    Buffer.byteLength(encoded, 'utf8') > SKILL_LIMITS.TEXT_READ_MAX_BYTES
    && chunkLines.length > 1
  ) {
    chunkLines = chunkLines.slice(0, -1);
    encoded = chunkLines.join('\n');
    truncated = true;
    end = start + chunkLines.length - 1;
  }
  if (Buffer.byteLength(encoded, 'utf8') > SKILL_LIMITS.TEXT_READ_MAX_BYTES) {
    // single oversized line — hard truncate bytes
    const buf = Buffer.from(encoded, 'utf8').subarray(0, SKILL_LIMITS.TEXT_READ_MAX_BYTES);
    encoded = buf.toString('utf8');
    truncated = true;
  }

  const actualEnd = start + chunkLines.length - 1;
  const hasMore = actualEnd < lines.length || truncated;
  return {
    path: 'SKILL.md',
    text: encoded,
    startLine: start,
    endLine: Math.max(start, actualEnd),
    truncated: truncated || actualEnd - start + 1 >= maxSpan && actualEnd < lines.length,
    hasMore,
    nextStartLine: hasMore && actualEnd < lines.length ? actualEnd + 1 : null,
  };
}

function scoreText(haystack: string, query: string): number {
  if (!query) return 0;
  const lower = haystack.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  let idx = 0;
  while (true) {
    const found = lower.indexOf(q, idx);
    if (found < 0) break;
    score += 1;
    idx = found + q.length;
  }
  return score;
}

function extractSnippet(text: string, query: string): { snippet: string; lineRange: { start: number; end: number } } {
  const lines = text.split('\n');
  const q = query.toLowerCase();
  let start = 1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.toLowerCase().includes(q)) {
      start = i + 1;
      break;
    }
  }
  const end = Math.min(lines.length, start + 4);
  let snippet = lines.slice(start - 1, end).join('\n');
  if (snippet.length > SKILL_LIMITS.SEARCH_SNIPPET_MAX_CHARS) {
    snippet = snippet.slice(0, SKILL_LIMITS.SEARCH_SNIPPET_MAX_CHARS);
  }
  return { snippet, lineRange: { start, end } };
}

export function createSkillService(deps: SkillServiceDeps): SkillService {
  const { repository, blobStore, versionService } = deps;
  const blobCache = new Map<string, CachedBlob>();
  const isActorActive =
    deps.isActorActive
    ?? (async (userId: string) => (await getActiveUserById(userId)) != null);
  const syncApi = createSkillSyncApi({ repository, blobStore, isActorActive });

  async function loadCaps(actor: SkillActor, skillId: string): Promise<{
    access: SkillAccessSnapshot;
    caps: SkillCapabilities;
  } | null> {
    const active = await isActorActive(actor.userId);
    const access = await repository.getAccessSnapshot(skillId, actor.userId);
    if (!access) return null;
    const caps = evaluateSkillPermissions(actor, {
      skill: skillRecordToPermissionSkill(access.skill),
      grants: access.grants,
      audienceUse: access.audienceUse,
      actorActive: active,
    });
    return { access, caps };
  }

  async function requireCaps(actor: SkillActor, skillId: string): Promise<{
    access: SkillAccessSnapshot;
    caps: SkillCapabilities;
  }> {
    try {
      const loaded = await loadCaps(actor, skillId);
      if (!loaded) {
        throw new SkillPolicyError('FORBIDDEN', 'Skill not found', 404);
      }
      return loaded;
    } catch (error) {
      if (error instanceof SkillPolicyError) throw error;
      // DB / infra failure — fail closed for runtime callers via unavailableResult;
      // for manage paths rethrow as FORBIDDEN-ish policy error.
      throw new SkillPolicyError('SKILL_UNAVAILABLE', 'Skill is unavailable', 503);
    }
  }

  async function readBlobCached(hash: string): Promise<CachedBlob> {
    const hit = blobCache.get(hash);
    if (hit) return hit;
    const stream = await blobStore.openVerified(hash);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    const entry = { bytes, isText: looksLikeText(bytes) };
    blobCache.set(hash, entry);
    return entry;
  }

  async function ensurePinned(
    ctx: SkillExecutionContext,
    name: string,
  ): Promise<SkillResult<{ pin: SkillPin; version: SkillVersionRecord; skill: SkillRecord }>> {
    try {
      const resolved = await repository.resolveByName(name);
      if (!resolved) return unavailableResult();

      const existing = ctx.pins.get(resolved.skill.id);
      const accessBundle = await loadCaps(ctx.auth, resolved.skill.id);
      if (!accessBundle || !accessBundle.caps.canUse) {
        return unavailableResult();
      }

      const { access } = accessBundle;
      const versionNumber = existing?.version ?? access.skill.publishedVersion;
      if (versionNumber == null) return unavailableResult();

      let version = await repository.getVersion(access.skill.id, versionNumber);
      if (!version || version.state !== 'published' || !version.manifestHash) {
        return unavailableResult();
      }

      // Re-check enabled/deleted via fresh snapshot (already in access)
      if (!access.skill.enabled || access.skill.deletedAt) {
        return unavailableResult();
      }

      let pin: SkillPin = {
        skillId: access.skill.id,
        name: access.skill.canonicalName,
        version: version.version,
        manifestHash: version.manifestHash,
      };
      const persisted = await repository.upsertRunPin({
        serverExecutionId: ctx.serverExecutionId,
        userId: ctx.auth.userId,
        threadId: ctx.threadId,
        pin,
      });
      if (persisted.userId !== ctx.auth.userId || persisted.threadId !== ctx.threadId
        || persisted.skillId !== pin.skillId) return unavailableResult();
      version = await repository.getVersion(pin.skillId, persisted.version);
      if (!version || version.state !== 'published' || !version.manifestHash
        || version.manifestHash !== persisted.manifestHash) return unavailableResult();
      pin = { skillId: persisted.skillId, name: access.skill.canonicalName,
        version: persisted.version, manifestHash: persisted.manifestHash };
      ctx.pins.set(pin.skillId, pin);
      return { ok: true, skill: pin, data: { pin, version, skill: access.skill } };
    } catch {
      return unavailableResult();
    }
  }

  async function ensurePinnedById(
    ctx: SkillExecutionContext,
    skillId: string,
  ): Promise<SkillResult<{ pin: SkillPin; version: SkillVersionRecord; skill: SkillRecord }>> {
    try {
      const skill = await repository.getSkill(skillId);
      if (!skill) return unavailableResult();
      return ensurePinned(ctx, skill.canonicalName);
    } catch {
      return unavailableResult();
    }
  }

  async function finishLoad(
    ctx: SkillExecutionContext,
    pinned: SkillResult<{ pin: SkillPin; version: SkillVersionRecord; skill: SkillRecord }>,
  ): Promise<SkillResult<SkillActivation>> {
    if (!pinned.ok) return pinned;

    const { pin, version } = pinned.data;
    const recheck = await loadCaps(ctx.auth, pin.skillId);
    if (!recheck || !recheck.caps.canUse) return unavailableResult();

    const files = await repository.listFiles(pin.skillId, pin.version);
    const summaries: SkillResourceSummary[] = files
      .slice(0, SKILL_LIMITS.LOAD_RESOURCE_SUMMARY_MAX)
      .map((f) => ({
        path: f.path,
        group: resourceGroup(f.path),
        isText: f.isText,
        size: f.size,
      }));
    const { instructions, description } = splitSkillMd(version.skillMd);

    if (deps.pool) {
      await deps.pool.query(
        `INSERT INTO app_skill_events (
           skill_id, version, actor_user_id, event, server_execution_id, result, safe_metadata
         ) VALUES ($1, $2, $3, 'load', $4, 'ok', $5::jsonb)`,
        [
          pin.skillId,
          pin.version,
          ctx.auth.userId,
          ctx.serverExecutionId,
          JSON.stringify({ action: 'load' }),
        ],
      );
    }

    return {
      ok: true,
      skill: pin,
      data: {
        instructions,
        description: description || version.description,
        baseUri: `skill://${pin.skillId}/${pin.version}/`,
        resources: summaries,
        hasMoreResources: files.length > SKILL_LIMITS.LOAD_RESOURCE_SUMMARY_MAX,
        availability: availabilityFromRuntime(version.runtimeManifest, deps.registeredToolIds?.(ctx.auth)??[]),
      },
    };
  }

  async function manageListDescription(
    skill: SkillRecord,
    caps: SkillCapabilities,
  ): Promise<string> {
    const versions = await repository.listVersions(skill.id);
    if (skill.publishedVersion != null) {
      const published = versions.find((version) => (
        version.version === skill.publishedVersion && version.state === 'published'
      ));
      return published?.description ?? '';
    }
    // Publish-only grants are in the manage list, but canViewDraft currently
    // includes them. Draft text stays limited to edit/manage.
    if (!caps.canEdit && !caps.canManage) return '';
    const draft = versions.find((version) => version.state === 'draft');
    return draft?.description ?? '';
  }

  const service: SkillService = {
    async listAvailable(actor, query) {
      const active = await isActorActive(actor.userId);
      if (!active) {
        return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
      }
      const page = await repository.listAvailable(actor, query);
      const items: SkillSummary[] = [];
      for (const skill of page.items) {
        if (skill.publishedVersion == null) continue;
        const version = await repository.getVersion(skill.id, skill.publishedVersion);
        if (!version) continue;
        const { description } = splitSkillMd(version.skillMd);
        items.push({
          id: skill.id,
          name: skill.canonicalName,
          description: description || version.description,
          version: version.version,
          userInvocable: true,
          availability: availabilityFromRuntime(version.runtimeManifest, deps.registeredToolIds?.(actor)??[]),
        });
      }
      return { items, total: page.total, page: page.page, pageSize: page.pageSize };
    },

    async listManageable(actor, query) {
      const active = await isActorActive(actor.userId);
      if (!active) {
        return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
      }
      const page = await repository.listManageable(actor, query);
      const items: SkillManageListItem[] = [];
      for (const skill of page.items) {
        const loaded = await loadCaps(actor, skill.id);
        if (!loaded) continue;
        items.push({
          ...skill,
          description: await manageListDescription(skill, loaded.caps),
          canEdit: loaded.caps.canEdit,
          canPublish: loaded.caps.canPublish,
          canManage: loaded.caps.canManage,
        });
      }
      return { items, total: page.total, page: page.page, pageSize: page.pageSize };
    },

    async load(ctx, name) {
      return finishLoad(ctx, await ensurePinned(ctx, name));
    },

    async loadById(ctx, skillId) {
      return finishLoad(ctx, await ensurePinnedById(ctx, skillId));
    },

    async read(ctx, input) {
      const pinned = await ensurePinned(ctx, input.skillName);
      if (!pinned.ok) return pinned;

      const recheck = await loadCaps(ctx.auth, pinned.data.pin.skillId);
      if (!recheck || !recheck.caps.canUse) return unavailableResult();

      const { pin, version } = pinned.data;
      let path: string;
      try {
        path = resolveResourcePath(input.path, pin);
      } catch {
        return failResult('PATH_INVALID', 'Invalid resource path');
      }

      if (path === 'SKILL.md') {
        const sliced = sliceTextLines(version.skillMd, input.startLine ?? 1, input.endLine);
        sliced.path = 'SKILL.md';
        if (deps.pool) {
          await deps.pool.query(
            `INSERT INTO app_skill_events (
               skill_id, version, actor_user_id, event, server_execution_id, result, safe_metadata
             ) VALUES ($1, $2, $3, 'read', $4, 'ok', $5::jsonb)`,
            [
              pin.skillId,
              pin.version,
              ctx.auth.userId,
              ctx.serverExecutionId,
              JSON.stringify({ path }),
            ],
          ).catch(() => undefined);
        }
        return { ok: true, skill: pin, data: sliced };
      }

      const file = await repository.getFile(pin.skillId, pin.version, path);
      if (!file) return failResult('NOT_FOUND', 'Resource not found');

      let blob: CachedBlob;
      try {
        blob = await readBlobCached(file.blobHash);
      } catch {
        return failResult('STORAGE_UNAVAILABLE', 'Resource storage unavailable');
      }

      if (!file.isText || !blob.isText) {
        return failResult(
          'RESOURCE_BINARY',
          `/agent-skills/${pin.skillId}/files/download?version=${pin.version}&path=${encodeURIComponent(path)}`,
        );
      }

      const text = new TextDecoder('utf-8', { fatal: false }).decode(blob.bytes);
      const sliced = sliceTextLines(text, input.startLine ?? 1, input.endLine);
      sliced.path = path;

      if (deps.pool) {
        await deps.pool.query(
          `INSERT INTO app_skill_events (
             skill_id, version, actor_user_id, event, server_execution_id, result, safe_metadata
           ) VALUES ($1, $2, $3, 'read', $4, 'ok', $5::jsonb)`,
          [
            pin.skillId,
            pin.version,
            ctx.auth.userId,
            ctx.serverExecutionId,
            JSON.stringify({ path }),
          ],
        ).catch(() => undefined);
      }

      return { ok: true, skill: pin, data: sliced };
    },

    async search(ctx, input) {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (
        query.length < SKILL_LIMITS.SEARCH_QUERY_MIN
        || query.length > SKILL_LIMITS.SEARCH_QUERY_MAX
      ) {
        return failResult('INVALID_INPUT', 'query length out of range');
      }
      const topK = Math.min(
        SKILL_LIMITS.SEARCH_TOPK_MAX,
        Math.max(1, input.topK ?? SKILL_LIMITS.SEARCH_TOPK_DEFAULT),
      );

      try {
        const active = await isActorActive(ctx.auth.userId);
        if (!active) {
          return { ok: true, skill: { skillId: '', name: '', version: 0, manifestHash: '' }, data: { hits: [], truncated: false } };
        }

        const candidates: Array<{ name: string; skillId: string }> = [];
        if (input.skillNames?.length) {
          for (const raw of input.skillNames) {
            const resolved = await repository.resolveByName(raw);
            if (!resolved) continue;
            const caps = await loadCaps(ctx.auth, resolved.skill.id);
            if (!caps || !caps.caps.canUse) continue;
            candidates.push({ name: resolved.skill.canonicalName, skillId: resolved.skill.id });
          }
        } else {
          // Content search — do not use query as a directory name filter.
          let pageNum = 1;
          for (;;) {
            const page = await repository.listAvailable(ctx.auth, {
              page: pageNum,
              pageSize: SKILL_LIMITS.PAGE_MAX,
            });
            for (const skill of page.items) {
              candidates.push({ name: skill.canonicalName, skillId: skill.id });
            }
            if (page.items.length < page.pageSize || candidates.length >= page.total) break;
            pageNum += 1;
            if (pageNum > 40) break;
          }
        }

        const hits: SkillSearchHit[] = [];
        let totalSnippetBytes = 0;
        let truncated = false;

        for (const candidate of candidates) {
          const pinned = await ensurePinned(ctx, candidate.name);
          if (!pinned.ok) continue;
          const recheck = await loadCaps(ctx.auth, pinned.data.pin.skillId);
          if (!recheck || !recheck.caps.canUse) continue;

          const { pin, version } = pinned.data;
          const texts: Array<{ path: string; text: string }> = [
            { path: 'SKILL.md', text: version.skillMd },
          ];
          const files = await repository.listFiles(pin.skillId, pin.version);
          for (const file of files) {
            if (!file.isText) continue;
            try {
              const blob = await readBlobCached(file.blobHash);
              if (!blob.isText) continue;
              texts.push({
                path: file.path,
                text: new TextDecoder('utf-8', { fatal: false }).decode(blob.bytes),
              });
            } catch {
              continue;
            }
          }

          for (const doc of texts) {
            const score = scoreText(doc.text, query);
            if (score <= 0) continue;
            const { snippet, lineRange } = extractSnippet(doc.text, query);
            const snippetBytes = Buffer.byteLength(snippet, 'utf8');
            if (totalSnippetBytes + snippetBytes > SKILL_LIMITS.SEARCH_TOTAL_SNIPPET_MAX_BYTES) {
              truncated = true;
              break;
            }
            totalSnippetBytes += snippetBytes;
            hits.push({ pin, path: doc.path, snippet, lineRange, score });
          }
          if (truncated) break;
        }

        hits.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (a.pin.name !== b.pin.name) return a.pin.name < b.pin.name ? -1 : 1;
          return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
        });

        const limited = hits.slice(0, topK);
        if (hits.length > topK) truncated = true;

        // Synthetic pin for ok envelope when multi-skill; use first hit pin or empty catalog pin
        const envelopePin: SkillPin = limited[0]?.pin ?? {
          skillId: '00000000-0000-4000-8000-000000000000',
          name: '',
          version: 0,
          manifestHash: '',
        };

        if (deps.pool && limited[0]) {
          await deps.pool.query(
            `INSERT INTO app_skill_events (
               skill_id, actor_user_id, event, server_execution_id, result, safe_metadata
             ) VALUES ($1, $2, 'search', $3, 'ok', $4::jsonb)`,
            [
              limited[0].pin.skillId,
              ctx.auth.userId,
              ctx.serverExecutionId,
              JSON.stringify({ hitCount: limited.length, truncated }),
            ],
          ).catch(() => undefined);
        }

        return {
          ok: true,
          skill: envelopePin,
          data: { hits: limited, truncated },
        };
      } catch {
        return unavailableResult();
      }
    },

    async createDraft(actor, input) {
      const active = await isActorActive(actor.userId);
      if (!active) {
        throw new SkillPolicyError('ACTOR_INACTIVE', 'Actor is not active', 403);
      }
      if (!isCanonicalSkillName(input.name)) {
        throw new SkillPolicyError('FORBIDDEN', 'Invalid skill name', 400);
      }
      const skillMd = input.skillMd
        ?? `---\nname: ${input.name}\ndescription: ${input.description}\n---\n\n# ${input.name}\n`;
      return repository.createDraft({
        ownerUserId: actor.userId,
        actorUserId: actor.userId,
        canonicalName: input.name,
        description: input.description,
        skillMd,
        alias: input.alias,
        groupId: input.groupId,
      });
    },

    async getManageDetail(actor, id) {
      const loaded = await requireCaps(actor, id);
      const { caps } = loaded;
      if (!caps.canViewDraft && !caps.canEdit && !caps.canPublish && !caps.canManage) {
        if (caps.canUse) {
          throw new SkillPolicyError('FORBIDDEN', 'Skill draft is not visible', 403);
        }
        throw unavailable();
      }
      assertCanViewDraft(caps);
      const draft = await repository.getDraftVersion(id);
      const published =
        loaded.access.skill.publishedVersion != null
          ? await repository.getVersion(id, loaded.access.skill.publishedVersion)
          : null;
      return {
        skill: loaded.access.skill,
        draft,
        published,
        canEdit: caps.canEdit,
        canPublish: caps.canPublish,
        canManage: caps.canManage,
        grants: caps.canManage ? await repository.listGrants(id) : [],
        audienceIds: caps.canManage ? await repository.listAudienceIdsForSkill(id) : [],
      };
    },

    async createWorkingDraft(actor, input) {
      const loaded = await requireCaps(actor, input.skillId);
      assertCanEdit(loaded.caps);
      return deriveWorkingDraft(versionService, actor, {
        skillId: input.skillId,
        expectedRevision: input.expectedRevision,
        actorUserId: actor.userId,
        fromVersion: input.fromVersion,
      });
    },

    async saveDraft(actor, input) {
      const loaded = await requireCaps(actor, input.skillId);
      assertCanEdit(loaded.caps);
      const existingDraft = await repository.getDraftVersion(input.skillId);
      let expectedRevision = input.expectedRevision;
      if (!existingDraft) {
        if (loaded.access.skill.publishedVersion == null) {
          throw new SkillPolicyError('FORBIDDEN', 'No draft version to update', 404);
        }
        const derived = await deriveWorkingDraft(versionService, actor, {
          skillId: input.skillId,
          expectedRevision: input.expectedRevision,
          actorUserId: actor.userId,
        });
        expectedRevision = derived.skill.revision;
      }
      return repository.updateDraft({
        skillId: input.skillId,
        expectedRevision,
        actorUserId: actor.userId,
        skillMd: input.skillMd,
        description: input.description,
      });
    },

    async saveFile(actor, input) {
      const loaded = await requireCaps(actor, input.skillId);
      assertCanEdit(loaded.caps);
      const path = normalizeSkillPath(input.path);
      if (path === 'SKILL.md' || path.toLowerCase() === 'skill.md') {
        throw new SkillPolicyError('FORBIDDEN', 'Use saveDraft to update SKILL.md', 400);
      }
      const isText = looksLikeText(input.bytes);
      const put = await blobStore.put(Readable.from([Buffer.from(input.bytes)]), SKILL_LIMITS.FILE_MAX_BYTES);
      const result = await repository.upsertDraftFile({
        skillId: input.skillId,
        expectedRevision: input.expectedRevision,
        actorUserId: actor.userId,
        runtimeManifest: path === 'skill-runtime.json' ? parseRuntimeManifest(input.bytes) : undefined,
        file: {
          path,
          blobHash: put.hash,
          size: put.size,
          mimeType: input.mimeType ?? null,
          isText,
        },
      });
      return { skill: result.skill, version: result.version };
    },

    async setMetadata(actor, input) {
      const loaded = await requireCaps(actor, input.skillId);
      assertCanManage(loaded.caps);
      if (input.visibility === 'global' && !loaded.caps.canSetGlobal) {
        throw new SkillPolicyError('FORBIDDEN', 'Only admin can set global visibility');
      }
      return repository.updateMetadata({
        skillId: input.skillId,
        expectedRevision: input.expectedRevision,
        actorUserId: actor.userId,
        visibility: input.visibility,
        groupId: input.groupId,
        grants: input.grants,
        audienceIds: input.audienceIds,
      });
    },

    async deleteDraftFile(actor, input) {
      const loaded = await requireCaps(actor, input.skillId);
      assertCanEdit(loaded.caps);
      const path = normalizeSkillPath(input.path);
      if (path === 'SKILL.md' || path.toLowerCase() === 'skill.md') {
        throw new SkillPolicyError('FORBIDDEN', 'Cannot delete SKILL.md via file API', 400);
      }
      return repository.deleteDraftFile({
        skillId: input.skillId,
        expectedRevision: input.expectedRevision,
        actorUserId: actor.userId,
        path,
      });
    },

    async setEnabled(actor, input) {
      const loaded = await requireCaps(actor, input.skillId);
      assertCanManage(loaded.caps);
      return repository.updateMetadata({
        skillId: input.skillId,
        expectedRevision: input.expectedRevision,
        actorUserId: actor.userId,
        enabled: input.enabled,
      });
    },

    async deleteSkill(actor, input) {
      const loaded = await requireCaps(actor, input.skillId);
      assertCanManage(loaded.caps);
      return repository.updateMetadata({
        skillId: input.skillId,
        expectedRevision: input.expectedRevision,
        actorUserId: actor.userId,
        deleted: true,
      });
    },

    async listEvents(actor, input) {
      const loaded = await requireCaps(actor, input.skillId);
      assertCanViewDraft(loaded.caps);
      return repository.listEvents(input.skillId, input);
    },

    async listVersions(actor, skillId) {
      const loaded = await requireCaps(actor, skillId);
      assertCanViewDraft(loaded.caps);
      return repository.listVersions(skillId);
    },

    async deleteVersion(actor, input) {
      const loaded = await requireCaps(actor, input.skillId);
      assertCanManage(loaded.caps);
      return deleteSkillVersion(versionService, actor, {
        skillId: input.skillId,
        version: input.version,
        expectedRevision: input.expectedRevision,
      });
    },

    async listFiles(actor, skillId, version) {
      const loaded = await requireCaps(actor, skillId);
      await assertVersionReadable(actor, loaded, version);
      return repository.listFiles(skillId, version);
    },

    async readFileContent(actor, skillId, version, path) {
      return openAuthorizedFile(actor, skillId, version, path, 'manage');
    },

    async downloadFile(actor, skillId, version, path) {
      return openAuthorizedFile(actor, skillId, version, path, 'download');
    },

    async exportZip(actor, skillId, version) {
      const loaded = await requireCaps(actor, skillId);
      await assertVersionReadable(actor, loaded, version);
      const versionRow = await repository.getVersion(skillId, version);
      if (!versionRow) {
        throw unavailable();
      }
      const files = await repository.listFiles(skillId, version);
      const writer = new ZipWriter(new Uint8ArrayWriter());
      await writer.add('SKILL.md', new Uint8ArrayReader(new TextEncoder().encode(versionRow.skillMd)));
      for (const file of files) {
        const blob = await readBlobCached(file.blobHash);
        await writer.add(file.path, new Uint8ArrayReader(blob.bytes));
      }
      const bytes = await writer.close();
      return {
        bytes,
        filename: `${loaded.access.skill.canonicalName}-v${version}.zip`,
      };
    },

    async publish(actor, input) {
      return publishSkill(versionService, actor, input);
    },

    async rollback(actor, input) {
      return rollbackSkill(versionService, actor, input);
    },

    async listGroups(_actor) {
      return repository.listGroups();
    },

    async createGroup(actor, input) {
      assertAdmin(actor);
      if (!input.name?.trim()) {
        throw new SkillPolicyError('FORBIDDEN', 'Group name required', 400);
      }
      return repository.createGroup({ name: input.name, sort: input.sort });
    },

    async updateGroup(actor, input) {
      assertAdmin(actor);
      return repository.updateGroup(input);
    },

    async deleteGroup(actor, id) {
      assertAdmin(actor);
      await repository.deleteGroup(id);
    },

    async listAudiences(actor) {
      assertAdmin(actor);
      return repository.listAudiences();
    },

    async createAudience(actor, input) {
      assertAdmin(actor);
      if (!input.name?.trim()) {
        throw new SkillPolicyError('FORBIDDEN', 'Audience name required', 400);
      }
      return repository.createAudience(input);
    },

    async updateAudience(actor, input) {
      assertAdmin(actor);
      return repository.updateAudience(input);
    },

    async deleteAudience(actor, id) {
      assertAdmin(actor);
      await repository.deleteAudience(id);
    },

    async searchUsers(actor, q) {
      const trimmed = q.trim();
      if (
        trimmed.length < SKILL_LIMITS.USER_QUERY_MIN
        || trimmed.length > SKILL_LIMITS.USER_QUERY_MAX
      ) {
        throw new SkillPolicyError('FORBIDDEN', 'q length out of range', 400);
      }
      await assertAdminOrSkillOwner(actor);
      return repository.searchUsers(trimmed, SKILL_LIMITS.USER_PICKER_LIMIT);
    },

    previewImport: (actor, stream) => syncApi.previewImport(actor, stream),
    commitImport: (actor, input) => syncApi.commitImport(actor, input),
    previewSync: (actor, input) => syncApi.previewSync(actor, input),
    commitSync: (actor, input) => syncApi.commitSync(actor, input),

    async listAvailableShortcuts(actor) {
      if (!(await isActorActive(actor.userId))) return { items: [] };
      const items = await shortcutStore().listAvailable(actor.userId);
      return { items };
    },

    async getShortcut(actor, skillId) {
      const loaded = await requireCaps(actor, skillId);
      assertCanManage(loaded.caps);
      return { shortcut: await shortcutStore().getBySkillId(skillId) };
    },

    async putShortcut(actor, input) {
      const loaded = await requireCaps(actor, input.skillId);
      assertCanManage(loaded.caps);
      const config: ShortcutConfig = validateShortcut(input.config);
      const shortcut = await shortcutStore().save(input.skillId, input.expectedRevision, config);
      return { shortcut };
    },
  };

  // The lease covers filesystem writes/verifications through their metadata commit.
  // Nested service calls reuse it; GC cannot remove resources between these phases.
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => withSkillStorageReadLock(deps.pool, async () => Reflect.apply(value, target, args));
    },
  });

  function shortcutStore() {
    return createSkillShortcutStore(shortcutDb(deps.pool ?? getPool()));
  }

  function shortcutDb(pool: Pool): ShortcutDb {
    const query = async <T,>(sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    };
    return {
      query,
      transaction: async (run) => {
        const client: PoolClient = await pool.connect();
        const tx: ShortcutDb = {
          query: async <T,>(sql: string, params?: unknown[]) => {
            const result = await client.query(sql, params);
            return { rows: result.rows as T[] };
          },
          transaction: (inner) => inner(tx),
        };
        try {
          await client.query('BEGIN');
          const result = await run(tx);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    };
  }

  function assertAdmin(actor: SkillActor): void {
    if (!actor.roles.includes('admin')) {
      throw new SkillPolicyError('FORBIDDEN', 'Admin permission required', 403);
    }
  }

  async function assertAdminOrSkillOwner(actor: SkillActor): Promise<void> {
    if (actor.roles.includes('admin')) return;
    if (await repository.userOwnsAnySkill(actor.userId)) return;
    throw new SkillPolicyError('FORBIDDEN', 'Admin or skill owner permission required', 403);
  }

  async function assertVersionReadable(
    actor: SkillActor,
    loaded: { access: SkillAccessSnapshot; caps: SkillCapabilities },
    version: number,
  ): Promise<void> {
    if (loaded.caps.canViewDraft) return;
    if (!loaded.caps.canUse) throw unavailable();
    assertCanUse(loaded.caps);
    const published = loaded.access.skill.publishedVersion;
    if (
      !loaded.access.skill.enabled
      || published == null
      || version !== published
    ) {
      throw unavailable();
    }
  }

  async function openAuthorizedFile(
    actor: SkillActor,
    skillId: string,
    version: number,
    rawPath: string,
    mode: 'manage' | 'download',
  ): Promise<SkillFileDownload> {
    const loaded = await requireCaps(actor, skillId);
    if (mode === 'download' && !loaded.caps.canViewDraft) {
      await assertVersionReadable(actor, loaded, version);
    } else if (mode === 'manage' && !loaded.caps.canViewDraft) {
      // manage content endpoints require draft-viewing rights
      if (loaded.caps.canUse) {
        throw new SkillPolicyError('FORBIDDEN', 'Skill draft is not visible', 403);
      }
      throw unavailable();
    } else {
      assertCanViewDraft(loaded.caps);
    }

    let path: string;
    try {
      path = normalizeSkillPath(rawPath);
    } catch {
      throw new SkillPolicyError('FORBIDDEN', 'Invalid resource path', 400);
    }

    if (path === 'SKILL.md') {
      const versionRow = await repository.getVersion(skillId, version);
      if (!versionRow) throw unavailable();
      return {
        bytes: new TextEncoder().encode(versionRow.skillMd),
        path,
        mimeType: 'text/markdown',
        isText: true,
      };
    }

    const file = await repository.getFile(skillId, version, path);
    if (!file) throw unavailable();
    let blob: CachedBlob;
    try {
      blob = await readBlobCached(file.blobHash);
    } catch {
      throw new SkillPolicyError('SKILL_UNAVAILABLE', 'Resource storage unavailable', 503);
    }
    return {
      bytes: blob.bytes,
      path: file.path,
      mimeType: file.mimeType,
      isText: file.isText,
    };
  }
}

