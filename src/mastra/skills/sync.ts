import type { ReadinessReport, ReadinessInput } from './readiness';
import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { BlobStore } from './blob-store';
import { SkillRepositoryError, SkillSyncError } from './errors';
import { previewSkillZip } from './package';
import {
  assertCanEdit,
  evaluateSkillPermissions,
  skillRecordToPermissionSkill,
  unavailable,
} from './policy';
import type { SkillRepository } from './repository';
import { reportSkillRuntimeCompatibility } from './runtime';
import type {
  SkillActor,
  SkillFileInput,
  SkillRecord,
  SkillRuntimeManifest,
  SkillSyncSessionRecord,
  SkillVersionRecord,
} from './types';
import { isCanonicalSkillName, isValidAlias, looksLikeText, SKILL_LIMITS } from './validation';

export type SkillDiffKind = 'add' | 'modify' | 'delete' | 'unchanged';

export type SkillDiffEntry = {
  path: string;
  kind: SkillDiffKind;
  baseHash: string | null;
  incomingHash: string | null;
  /** Deletes and unchanged paths start unselected. */
  selected: boolean;
};

export type SkillTreeEntry = { path: string; hash: string };

export type SkillReferenceRenameRisk = {
  path: string;
  message: string;
};

export type SkillImportReport = {
  readiness?: ReadinessReport;
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

export type CommitImportInput = {
  importId: string;
  acceptedName: string;
  alias?: string | null;
  targetSkillId?: string;
  expectedRevision?: string;
};

export type CommitSyncInput = {
  skillId: string;
  syncId: string;
  expectedRevision: string;
  selectedPaths: string[];
  includeDeletes: boolean;
};

type StoredFile = { path: string; hash: string; size: number };

type ImportPayload = {
  sourceName: string;
  suggestedCanonicalName: string;
  requiresNameAcceptance: boolean;
  canonicalName: string;
  description: string;
  warnings: string[];
  referenceRenameRisks: SkillReferenceRenameRisk[];
  compatibility: string;
  files: StoredFile[];
  runtimeManifest: SkillRuntimeManifest | null;
};

type SyncPayload = {
  description: string;
  runtimeManifest: SkillRuntimeManifest | null;
  files: StoredFile[];
  entries: SkillDiffEntry[];
};

export function hashSkillBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Hash compare of draft tree vs incoming package. Deletes are not selected. */
export function diffSkillTrees(base: SkillTreeEntry[], incoming: SkillTreeEntry[]): SkillDiffEntry[] {
  const baseMap = new Map(base.map((entry) => [entry.path, entry.hash]));
  const incomingMap = new Map(incoming.map((entry) => [entry.path, entry.hash]));
  const paths = [...new Set([...baseMap.keys(), ...incomingMap.keys()])].sort((a, b) => a.localeCompare(b));
  return paths.map((path) => {
    const baseHash = baseMap.get(path) ?? null;
    const incomingHash = incomingMap.get(path) ?? null;
    let kind: SkillDiffKind;
    if (baseHash == null) kind = 'add';
    else if (incomingHash == null) kind = 'delete';
    else if (baseHash === incomingHash) kind = 'unchanged';
    else kind = 'modify';
    return {
      path,
      kind,
      baseHash,
      incomingHash,
      selected: kind === 'add' || kind === 'modify',
    };
  });
}

export function referenceRenameRisks(
  sourceName: string,
  suggestedName: string,
  texts: Array<{ path: string; text: string }>,
): SkillReferenceRenameRisk[] {
  if (!sourceName || sourceName === suggestedName) return [];
  const message = `来源名「${sourceName}」与规范名「${suggestedName}」不同。接受新名称不会自动改写正文或资源里的引用，跨技能引用可能失效。`;
  const hits = texts
    .filter((file) => file.text.includes(sourceName))
    .map((file) => ({ path: file.path, message }));
  return hits.length > 0 ? hits : [{ path: 'SKILL.md', message }];
}

export type SkillSyncApi = {
  previewImport: (actor: SkillActor, stream: ReadableStream<Uint8Array>) => Promise<{
    importId: string;
    report: SkillImportReport;
  }>;
  commitImport: (actor: SkillActor, input: CommitImportInput) => Promise<{
    skill: SkillRecord;
    version: SkillVersionRecord;
  }>;
  previewSync: (
    actor: SkillActor,
    input: { skillId: string; expectedRevision: string; stream: ReadableStream<Uint8Array> },
  ) => Promise<{ syncId: string; diff: SkillSyncDiff }>;
  commitSync: (actor: SkillActor, input: CommitSyncInput) => Promise<{
    skill: SkillRecord;
    version: SkillVersionRecord;
  }>;
};

export type SkillSyncApiDeps = {
  checkReadiness?: (actor: SkillActor, input: Omit<ReadinessInput, "toolIds">) => Promise<ReadinessReport>;
  repository: SkillRepository;
  blobStore: BlobStore;
  isActorActive?: (userId: string) => Promise<boolean>;
  /** Test hook inside the commit transaction, before the session is consumed. */
  beforeSessionConsume?: () => Promise<void>;
};

export function createSkillSyncApi(deps: SkillSyncApiDeps): SkillSyncApi {
  const { repository, blobStore } = deps;
  const isActorActive = deps.isActorActive ?? (async () => true);

  async function requireActive(actor: SkillActor): Promise<void> {
    if (!(await isActorActive(actor.userId))) {
      throw unavailable('Actor is not active');
    }
  }

  async function requireEdit(actor: SkillActor, skillId: string): Promise<SkillRecord> {
    await requireActive(actor);
    const snapshot = await repository.getAccessSnapshot(skillId, actor.userId);
    if (!snapshot) throw unavailable();
    const caps = evaluateSkillPermissions(actor, {
      skill: skillRecordToPermissionSkill(snapshot.skill),
      grants: snapshot.grants,
      audienceUse: snapshot.audienceUse,
      actorActive: true,
    });
    assertCanEdit(caps);
    return snapshot.skill;
  }

  return {
    async previewImport(actor, stream) {
      await requireActive(actor);
      const preview = await previewSkillZip(stream);
      try {
        const files = await hashMaterialized(preview.tempRoot);
        const texts = textEntries(preview.package.skillMd, preview.package.resources);
        const risks = referenceRenameRisks(
          preview.package.sourceName,
          preview.package.suggestedCanonicalName,
          texts,
        );
        const scriptTexts: Record<string, string> = {};
        for (const resource of preview.package.resources) {
          if (!resource.path.startsWith('scripts/') || !resource.isText) continue;
          scriptTexts[resource.path] = new TextDecoder().decode(resource.bytes);
        }
        const report: SkillImportReport = {
          ...(deps.checkReadiness ? { readiness: await deps.checkReadiness(actor, { skillMd: preview.package.skillMd, runtime: preview.package.runtimeManifest, files: files.map(file => ({ path: file.path, hash: file.hash })) }) } : {}),
          importId: preview.importId,
          expiresAt: preview.expiresAt.toISOString(),
          sourceName: preview.package.sourceName,
          suggestedCanonicalName: preview.package.suggestedCanonicalName,
          requiresNameAcceptance: preview.package.requiresNameAcceptance,
          canonicalName: preview.package.canonicalName,
          description: preview.package.description,
          warnings: preview.package.warnings,
          referenceRenameRisks: risks,
          compatibility: reportSkillRuntimeCompatibility(preview.package.runtimeManifest, {
            registeredToolIds: [],
            scriptTexts,
          }),
          files: files.map((file) => ({ path: file.path, hash: file.hash, size: file.size })),
        };
        const payload: ImportPayload = {
          sourceName: report.sourceName,
          suggestedCanonicalName: report.suggestedCanonicalName,
          requiresNameAcceptance: report.requiresNameAcceptance,
          canonicalName: report.canonicalName,
          description: report.description,
          warnings: report.warnings,
          referenceRenameRisks: report.referenceRenameRisks,
          compatibility: report.compatibility,
          files: report.files,
          runtimeManifest: preview.package.runtimeManifest,
        };
        await repository.insertSyncSession({
          id: preview.importId,
          kind: 'import',
          skillId: null,
          baseRevision: null,
          version: null,
          actorUserId: actor.userId,
          payload,
          tempRoot: preview.tempRoot,
          expiresAt: preview.expiresAt,
        });
        return { importId: preview.importId, report };
      } catch (error) {
        await rm(preview.tempRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },

    async commitImport(actor, input) {
      await requireActive(actor);
      const acceptedName = input.acceptedName.trim();
      if (!isCanonicalSkillName(acceptedName)) {
        throw new SkillRepositoryError('INVALID_INPUT', 'acceptedName is not a canonical skill name', 400);
      }
      if (input.alias) {
        if (!isValidAlias(input.alias)) {
          throw new SkillRepositoryError('INVALID_INPUT', 'alias is invalid', 400);
        }
      }
      if (input.targetSkillId && !input.expectedRevision) {
        throw new SkillRepositoryError('INVALID_INPUT', 'expectedRevision is required when updating a skill', 400);
      }

      const loaded = await loadVerifiedTree(repository, input.importId);
      const session = await assertOwnedSession(repository, actor, input.importId, 'import');
      const payload = asImportPayload(session.payload);
      if (payload.requiresNameAcceptance && acceptedName !== payload.suggestedCanonicalName) {
        throw new SkillRepositoryError('INVALID_INPUT', 'acceptedName must match the suggested canonical name', 400);
      }
      if (!payload.requiresNameAcceptance && acceptedName !== payload.canonicalName) {
        throw new SkillRepositoryError('INVALID_INPUT', 'acceptedName does not match the package name', 400);
      }
      assertHashes(payload.files, loaded.hashes);

      const resources = await toFileInputs(blobStore, loaded.bytes);
      const skillMdBytes = loaded.bytes.get('SKILL.md');
      if (!skillMdBytes) throw new SkillSyncError('HASH_MISMATCH', 'SKILL.md missing from import session', 409);
      const skillMd = new TextDecoder().decode(skillMdBytes);

      if (input.targetSkillId) {
        const current = await requireEdit(actor, input.targetSkillId);
        if (current.publishedVersion != null && acceptedName !== current.canonicalName) {
          throw new SkillSyncError('NAME_LOCKED', 'Published skill name cannot be changed', 409);
        }
      }

      const saved = await repository.transaction(async (tx) => {
        const locked = await tx.lockSyncSession(input.importId);
        assertLockedSession(locked, actor, 'import');
        let result: { skill: SkillRecord; version: SkillVersionRecord };
        if (input.targetSkillId) {
          await requireEdit(actor, input.targetSkillId);
          result = await tx.applyDraftPackage({
            skillId: input.targetSkillId,
            expectedRevision: input.expectedRevision!,
            actorUserId: actor.userId,
            event: 'import',
            description: payload.description,
            skillMd,
            runtimeManifest: payload.runtimeManifest,
            files: resources,
            canonicalName: acceptedName,
            alias: input.alias === undefined ? undefined : input.alias,
          });
        } else {
          result = await tx.createDraft({
            ownerUserId: actor.userId,
            actorUserId: actor.userId,
            canonicalName: acceptedName,
            description: payload.description,
            skillMd,
            alias: input.alias,
            runtimeManifest: payload.runtimeManifest,
            files: resources,
          });
          await tx.recordSkillEvent({
            skillId: result.skill.id,
            version: result.version.version,
            actorUserId: actor.userId,
            event: 'import',
            result: 'ok',
          });
        }
        if (!input.targetSkillId && (result.skill.enabled || result.skill.publishedVersion != null)) {
          throw new SkillRepositoryError('INVALID_INPUT', 'Import must not publish or enable', 500);
        }
        if (deps.beforeSessionConsume) await deps.beforeSessionConsume();
        const consumed = await tx.consumeSyncSession(input.importId, result.skill.id);
        if (!consumed) throw new SkillSyncError('SESSION_CONSUMED', 'Import session is no longer pending', 409);
        return result;
      });
      await rm(session.tempRoot, { recursive: true, force: true }).catch(() => undefined);
      return saved;
    },

    async previewSync(actor, input) {
      const skill = await requireEdit(actor, input.skillId);
      if (skill.revision !== input.expectedRevision) {
        throw new SkillRepositoryError(
          'REVISION_CONFLICT',
          `expectedRevision ${input.expectedRevision} does not match current ${skill.revision}`,
        );
      }
      const draft = await repository.getDraftVersion(input.skillId);
      if (!draft) throw new SkillSyncError('DRAFT_REQUIRED', 'Sync targets the draft, which is missing', 404);
      const preview = await previewSkillZip(input.stream);
      try {
        const incoming = await hashMaterialized(preview.tempRoot);
        const base = await draftTree(repository, input.skillId, draft.version, draft.skillMd);
        const entries = diffSkillTrees(base, incoming);
        const diff: SkillSyncDiff = {
          syncId: preview.importId,
          skillId: input.skillId,
          baseRevision: skill.revision,
          draftVersion: draft.version,
          expiresAt: preview.expiresAt.toISOString(),
          entries,
        };
        const payload: SyncPayload = {
          description: preview.package.description,
          runtimeManifest: preview.package.runtimeManifest,
          files: incoming,
          entries,
        };
        await repository.insertSyncSession({
          id: preview.importId,
          kind: 'sync',
          skillId: input.skillId,
          baseRevision: skill.revision,
          version: draft.version,
          actorUserId: actor.userId,
          payload,
          tempRoot: preview.tempRoot,
          expiresAt: preview.expiresAt,
        });
        return { syncId: preview.importId, diff };
      } catch (error) {
        await rm(preview.tempRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },

    async commitSync(actor, input) {
      const session = await assertOwnedSession(repository, actor, input.syncId, 'sync', input.skillId);
      const skill = await requireEdit(actor, input.skillId);
      if (session.baseRevision !== input.expectedRevision || skill.revision !== input.expectedRevision) {
        throw new SkillRepositoryError(
          'REVISION_CONFLICT',
          `expectedRevision ${input.expectedRevision} does not match current ${skill.revision}`,
        );
      }
      const payload = asSyncPayload(session.payload);
      const loaded = await loadVerifiedTree(repository, input.syncId);
      assertHashes(payload.files, loaded.hashes);
      const selected = normalizeSelected(input.selectedPaths, payload.entries, input.includeDeletes);

      const draft = await repository.getDraftVersion(input.skillId);
      if (!draft) throw new SkillSyncError('DRAFT_REQUIRED', 'Sync targets the draft, which is missing', 404);
      const currentFiles = await repository.listFiles(input.skillId, draft.version);
      const next = new Map(currentFiles.map((file) => [file.path, file]));
      let skillMd: string | undefined;
      let description: string | undefined;
      let runtimeManifest: SkillRuntimeManifest | null | undefined;

      for (const path of selected) {
        const entry = payload.entries.find((item) => item.path === path)!;
        if (entry.kind === 'delete') {
          if (path === 'SKILL.md') {
            throw new SkillSyncError('PATH_NOT_IN_DIFF', 'SKILL.md cannot be deleted', 400);
          }
          next.delete(path);
          if (path === 'skill-runtime.json') runtimeManifest = null;
          continue;
        }
        if (entry.kind === 'unchanged') continue;
        const bytes = loaded.bytes.get(path);
        if (!bytes) throw new SkillSyncError('HASH_MISMATCH', `Missing bytes for ${path}`, 409);
        if (path === 'SKILL.md') {
          skillMd = new TextDecoder().decode(bytes);
          description = payload.description;
          continue;
        }
        const put = await blobStore.put(Readable.from([Buffer.from(bytes)]), SKILL_LIMITS.FILE_MAX_BYTES);
        if (put.hash !== entry.incomingHash) {
          throw new SkillSyncError('HASH_MISMATCH', `Blob hash mismatch for ${path}`, 409);
        }
        next.set(path, {
          skillId: input.skillId,
          version: draft.version,
          path,
          blobHash: put.hash,
          size: put.size,
          mimeType: null,
          isText: looksLikeText(bytes),
        });
        if (path === 'skill-runtime.json') runtimeManifest = payload.runtimeManifest;
      }

      const files: SkillFileInput[] = [...next.values()].map((file) => ({
        path: file.path,
        blobHash: file.blobHash,
        size: file.size,
        mimeType: file.mimeType,
        isText: file.isText,
      }));

      const saved = await repository.transaction(async (tx) => {
        const locked = await tx.lockSyncSession(input.syncId);
        assertLockedSession(locked, actor, 'sync', input.skillId);
        if (locked!.baseRevision !== input.expectedRevision) {
          throw new SkillRepositoryError(
            'REVISION_CONFLICT',
            `expectedRevision ${input.expectedRevision} does not match session ${locked!.baseRevision}`,
          );
        }
        await requireEdit(actor, input.skillId);
        const applied = await tx.applyDraftPackage({
          skillId: input.skillId,
          expectedRevision: input.expectedRevision,
          actorUserId: actor.userId,
          event: 'sync',
          description,
          skillMd,
          runtimeManifest,
          files,
        });
        if (deps.beforeSessionConsume) await deps.beforeSessionConsume();
        const consumed = await tx.consumeSyncSession(input.syncId, input.skillId);
        if (!consumed) throw new SkillSyncError('SESSION_CONSUMED', 'Sync session is no longer pending', 409);
        return applied;
      });
      await rm(session.tempRoot, { recursive: true, force: true }).catch(() => undefined);
      return saved;
    },
  };
}

function textEntries(
  skillMd: string,
  resources: Array<{ path: string; bytes: Uint8Array; isText: boolean }>,
): Array<{ path: string; text: string }> {
  const texts = [{ path: 'SKILL.md', text: skillMd }];
  for (const resource of resources) {
    if (!resource.isText) continue;
    texts.push({ path: resource.path, text: new TextDecoder().decode(resource.bytes) });
  }
  return texts;
}

async function hashMaterialized(tempRoot: string): Promise<StoredFile[]> {
  const bytes = await readMaterialized(tempRoot);
  return [...bytes.entries()]
    .map(([path, data]) => ({ path, hash: hashSkillBytes(data), size: data.byteLength }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function readMaterialized(tempRoot: string): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) out.set(rel, new Uint8Array(await readFile(full)));
    }
  }
  await walk(tempRoot, '');
  return out;
}

async function loadVerifiedTree(
  repository: SkillRepository,
  sessionId: string,
): Promise<{ bytes: Map<string, Uint8Array>; hashes: Map<string, string> }> {
  const session = await repository.lockSyncSession(sessionId);
  if (!session) throw new SkillSyncError('SESSION_NOT_FOUND', 'Session not found', 404);
  const bytes = await readMaterialized(session.tempRoot);
  const hashes = new Map<string, string>();
  for (const [path, data] of bytes) hashes.set(path, hashSkillBytes(data));
  return { bytes, hashes };
}

function assertHashes(expected: StoredFile[], actual: Map<string, string>): void {
  if (expected.length !== actual.size) {
    throw new SkillSyncError('HASH_MISMATCH', 'Import tree no longer matches the preview', 409);
  }
  for (const file of expected) {
    if (actual.get(file.path) !== file.hash) {
      throw new SkillSyncError('HASH_MISMATCH', `Hash mismatch for ${file.path}`, 409);
    }
  }
}

async function assertOwnedSession(
  repository: SkillRepository,
  actor: SkillActor,
  sessionId: string,
  kind: 'import' | 'sync',
  skillId?: string,
): Promise<SkillSyncSessionRecord> {
  const session = await repository.lockSyncSession(sessionId);
  assertLockedSession(session, actor, kind, skillId);
  return session!;
}

function assertLockedSession(
  session: SkillSyncSessionRecord | null,
  actor: SkillActor,
  kind: 'import' | 'sync',
  skillId?: string,
): asserts session is SkillSyncSessionRecord {
  if (!session || session.actorUserId !== actor.userId || session.kind !== kind) {
    throw new SkillSyncError('SESSION_NOT_FOUND', 'Session not found', 404);
  }
  if (skillId && session.skillId !== skillId) {
    throw new SkillSyncError('SESSION_NOT_FOUND', 'Session not found', 404);
  }
  if (session.status !== 'pending') {
    throw new SkillSyncError('SESSION_CONSUMED', 'Session is no longer pending', 409);
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw new SkillSyncError('SESSION_EXPIRED', 'Preview session expired', 410);
  }
}

function asImportPayload(payload: unknown): ImportPayload {
  if (!payload || typeof payload !== 'object') {
    throw new SkillSyncError('HASH_MISMATCH', 'Import session payload is invalid', 409);
  }
  return payload as ImportPayload;
}

function asSyncPayload(payload: unknown): SyncPayload {
  if (!payload || typeof payload !== 'object') {
    throw new SkillSyncError('HASH_MISMATCH', 'Sync session payload is invalid', 409);
  }
  return payload as SyncPayload;
}

function normalizeSelected(paths: string[], entries: SkillDiffEntry[], includeDeletes: boolean): string[] {
  const unique = [...new Set(paths)];
  if (unique.length !== paths.length) {
    throw new SkillSyncError('PATH_NOT_IN_DIFF', 'Duplicate selected path', 400);
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const path of unique) {
    const entry = byPath.get(path);
    if (!entry) throw new SkillSyncError('PATH_NOT_IN_DIFF', `Path is not in the preview diff: ${path}`, 400);
    if (entry.kind === 'delete' && !includeDeletes) {
      throw new SkillSyncError('PATH_NOT_IN_DIFF', 'Deletes require includeDeletes', 400);
    }
  }
  return unique;
}

async function draftTree(
  repository: SkillRepository,
  skillId: string,
  version: number,
  skillMd: string,
): Promise<SkillTreeEntry[]> {
  const files = await repository.listFiles(skillId, version);
  const entries: SkillTreeEntry[] = [
    { path: 'SKILL.md', hash: hashSkillBytes(new TextEncoder().encode(skillMd)) },
  ];
  for (const file of files) {
    entries.push({ path: file.path, hash: file.blobHash });
  }
  return entries;
}

async function toFileInputs(
  blobStore: BlobStore,
  bytes: Map<string, Uint8Array>,
): Promise<SkillFileInput[]> {
  const files: SkillFileInput[] = [];
  for (const [path, data] of bytes) {
    if (path === 'SKILL.md') continue;
    const put = await blobStore.put(Readable.from([Buffer.from(data)]), SKILL_LIMITS.FILE_MAX_BYTES);
    files.push({
      path,
      blobHash: put.hash,
      size: put.size,
      mimeType: null,
      isText: looksLikeText(data),
    });
  }
  return files;
}
