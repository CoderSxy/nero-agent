import { readdir, rm, stat } from 'node:fs/promises';
import type { Pool } from 'pg';
import { withSkillStorageReadLock, withSkillStorageWriteLock } from './storage-lock';
import { join } from 'node:path';
import { getPool } from '../auth/db';
import { skillScriptOrphanMaxAgeMs } from '../sandbox/cleaner';
import { SKILL_SCRIPT_RUN_LABEL } from './script-container';
import { SkillStorageError } from './errors';
import { createBlobStore } from './blob-store';
import { getSkillsStorageRoot, isAgentSkillsEnabled } from './config';
import { createReleaseStore, type ReleaseStore } from './release-store';
import type { SkillManifestEntry } from './types';
import { isSha256Hex } from './validation';

/** Unreferenced blobs, orphan releases, staging, and expired import temps. */
export const SKILL_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Run pins may be deleted only this long after expires_at. */
export const SKILL_RUN_PIN_ENDED_GRACE_MS = SKILL_GC_GRACE_MS;
/** Runtime audit events (load/read/search/execute). Other events are kept. */
export const SKILL_AUDIT_RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const RUN_AUDIT_EVENTS = new Set(['load', 'read', 'search', 'execute']);

export type ReconcileTarget = {
  skillId: string;
  version: number;
  manifestHash: string;
  skillMd: string;
  entries: SkillManifestEntry[];
};

export type ReconcileReport = {
  dryRun: boolean;
  rebuilt: Array<{ skillId: string; version: number; manifestHash: string }>;
  wouldRebuild: Array<{ skillId: string; version: number; manifestHash: string }>;
  unavailable: Array<{ skillId: string; version: number; code: string; status: number }>;
  unchanged: number;
};

export type ReconcileDeps = {
  listCurrentPublished: () => Promise<ReconcileTarget[]>;
  releaseStore: ReleaseStore;
  markUnavailable: (target: ReconcileTarget, error: SkillStorageError) => Promise<void>;
  withLock?: <T>(skillId: string, fn: () => Promise<T>) => Promise<T>;
};

const releaseLocks = new Map<string, Promise<unknown>>();

/** In-process mutex so two reconciles in one process cannot delete each other's staging. */
export async function withSkillReleaseLock<T>(skillId: string, fn: () => Promise<T>): Promise<T> {
  const prev = releaseLocks.get(skillId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  releaseLocks.set(skillId, run.then(() => undefined, () => undefined));
  return run;
}

async function withPgReleaseLock<T>(skillId: string, fn: () => Promise<T>): Promise<T> {
  return withSkillReleaseLock(skillId, async () => {
    const client = await getPool().connect();
    const key = `nero-skill-release:${skillId}`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
      client.release();
    }
  });
}

function asUnavailable(error: SkillStorageError): SkillStorageError {
  if (error.status === 503) return error;
  return new SkillStorageError(error.code, error.message, 503);
}

/**
 * Verify current published releases. Missing trees are rebuilt from trusted blobs.
 * A bad blob marks the release unavailable (503) and does not move the publish pointer.
 */
async function reconcileSkillsUnlocked(
  options: { dryRun: boolean },
  deps?: ReconcileDeps,
): Promise<ReconcileReport> {
  const resolved = deps ?? await defaultReconcileDeps();
  const lock = resolved.withLock ?? withSkillReleaseLock;
  const report: ReconcileReport = {
    dryRun: options.dryRun,
    rebuilt: [],
    wouldRebuild: [],
    unavailable: [],
    unchanged: 0,
  };

  for (const target of await resolved.listCurrentPublished()) {
    await lock(target.skillId, async () => {
      try {
        await resolved.releaseStore.verifyRelease(target.skillId, target.version, target.manifestHash);
        report.unchanged += 1;
        return;
      } catch (error) {
        if (!(error instanceof SkillStorageError)) throw error;
        if (error.code !== 'RELEASE_INCOMPLETE') {
          const surfaced = asUnavailable(error);
          await resolved.markUnavailable(target, surfaced);
          report.unavailable.push({
            skillId: target.skillId,
            version: target.version,
            code: surfaced.code,
            status: surfaced.status,
          });
          return;
        }
      }

      if (options.dryRun) {
        report.wouldRebuild.push({
          skillId: target.skillId,
          version: target.version,
          manifestHash: target.manifestHash,
        });
        return;
      }

      try {
        const rebuilt = await resolved.releaseStore.materialize(target.skillId, target.version, {
          skillId: target.skillId,
          version: target.version,
          skillMd: target.skillMd,
          entries: target.entries,
        });
        report.rebuilt.push({
          skillId: target.skillId,
          version: target.version,
          manifestHash: rebuilt.manifestHash,
        });
      } catch (error) {
        if (!(error instanceof SkillStorageError)) throw error;
        const surfaced = asUnavailable(error);
        await resolved.markUnavailable(target, surfaced);
        report.unavailable.push({
          skillId: target.skillId,
          version: target.version,
          code: surfaced.code,
          status: surfaced.status,
        });
      }
    });
  }

  return report;
}

export async function reconcileSkills(
  options: { dryRun: boolean },
  deps?: ReconcileDeps,
): Promise<ReconcileReport> {
  if (deps) return reconcileSkillsUnlocked(options, deps);
  return withSkillStorageReadLock(getPool(), () => reconcileSkillsUnlocked(options));
}

async function defaultReconcileDeps(): Promise<ReconcileDeps> {
  const root = getSkillsStorageRoot();
  const blobStore = createBlobStore({ root });
  const releaseStore = createReleaseStore({ root, blobStore });
  return {
    releaseStore,
    withLock: withPgReleaseLock,
    listCurrentPublished: () => listCurrentPublishedReleases(),
    markUnavailable: async (target, error) => {
      console.error(
        `skill release unavailable ${target.skillId}@${target.version} ${error.code}`,
      );
    },
  };
}

async function listCurrentPublishedReleases(): Promise<ReconcileTarget[]> {
  const pool = getPool();
  const versions = await pool.query<{
    skill_id: string;
    version: number;
    manifest_hash: string;
    skill_md: string;
  }>(
    `SELECT s.id AS skill_id, s.published_version AS version, v.manifest_hash, v.skill_md
     FROM app_skills s
     JOIN app_skill_versions v
       ON v.skill_id = s.id AND v.version = s.published_version
     WHERE s.deleted_at IS NULL
       AND s.published_version IS NOT NULL
       AND v.state = 'published'
       AND v.manifest_hash IS NOT NULL`,
  );
  const targets: ReconcileTarget[] = [];
  for (const row of versions.rows) {
    const files = await pool.query<{
      path: string;
      blob_hash: string;
      size: string;
      is_text: boolean;
      mime_type: string | null;
    }>(
      `SELECT path, blob_hash, size::text AS size, is_text, mime_type
       FROM app_skill_files
       WHERE skill_id = $1 AND version = $2
       ORDER BY path`,
      [row.skill_id, row.version],
    );
    targets.push({
      skillId: row.skill_id,
      version: row.version,
      manifestHash: row.manifest_hash,
      skillMd: row.skill_md,
      entries: files.rows
        .filter((file) => file.path !== 'SKILL.md')
        .map((file) => ({
          path: file.path,
          blobHash: file.blob_hash,
          size: Number(file.size),
          isText: file.is_text,
          mimeType: file.mime_type,
        })),
    });
  }
  return targets;
}

/** Fire-and-forget startup reconcile. Disabled skills leave the process untouched. */
export function startSkillsReconcile(): void {
  if (!isAgentSkillsEnabled()) return;
  void reconcileSkills({ dryRun: false }).catch((error) => {
    console.error('skill reconcile failed', error instanceof Error ? error.name : 'unknown');
  });
}

export type SkillGcBlob = { hash: string; mtimeMs: number; referenced: boolean };
export type SkillGcRelease = {
  id: string;
  mtimeMs: number;
  currentPublished: boolean;
  activePin: boolean;
};
export type SkillGcStaging = { id: string; mtimeMs: number };
export type SkillGcSession = {
  id: string;
  kind: 'import' | 'sync';
  expiresAtMs: number;
  path: string;
};
export type SkillGcEvent = { id: string; event: string; createdAtMs: number };
export type SkillGcPin = { id: string; expiresAtMs: number; renewed?: boolean };

export type SkillGcInventory = {
  nowMs: number;
  blobs: SkillGcBlob[];
  releases: SkillGcRelease[];
  staging: SkillGcStaging[];
  importSessions: SkillGcSession[];
  runEvents: SkillGcEvent[];
  runPins: SkillGcPin[];
};

export type SkillGcPlanItem = {
  kind: 'blob' | 'release' | 'staging' | 'import-temp' | 'run-event' | 'run-pin';
  id: string;
  eligible: boolean;
};

export function planSkillGarbage(
  inventory: SkillGcInventory,
  limits: {
    graceMs?: number;
    auditRetentionMs?: number;
    pinEndedGraceMs?: number;
  } = {},
): { items: SkillGcPlanItem[] } {
  const graceMs = limits.graceMs ?? SKILL_GC_GRACE_MS;
  const auditMs = limits.auditRetentionMs ?? SKILL_AUDIT_RUN_RETENTION_MS;
  const pinMs = limits.pinEndedGraceMs ?? SKILL_RUN_PIN_ENDED_GRACE_MS;
  const now = inventory.nowMs;
  const items: SkillGcPlanItem[] = [];

  for (const blob of inventory.blobs) {
    items.push({
      kind: 'blob',
      id: blob.hash,
      eligible: !blob.referenced && now - blob.mtimeMs >= graceMs,
    });
  }
  for (const release of inventory.releases) {
    items.push({
      kind: 'release',
      id: release.id,
      eligible: !release.currentPublished
        && !release.activePin
        && now - release.mtimeMs >= graceMs,
    });
  }
  for (const staging of inventory.staging) {
    items.push({
      kind: 'staging',
      id: staging.id,
      eligible: now - staging.mtimeMs >= graceMs,
    });
  }
  for (const session of inventory.importSessions) {
    items.push({
      kind: 'import-temp',
      id: session.id,
      eligible: now - session.expiresAtMs >= graceMs,
    });
  }
  for (const event of inventory.runEvents) {
    items.push({
      kind: 'run-event',
      id: event.id,
      eligible: RUN_AUDIT_EVENTS.has(event.event) && now - event.createdAtMs >= auditMs,
    });
  }
  for (const pin of inventory.runPins) {
    const endedFor = now - pin.expiresAtMs;
    items.push({
      kind: 'run-pin',
      id: pin.id,
      eligible: pin.expiresAtMs <= now && endedFor >= pinMs,
    });
  }
  return { items };
}

export async function runSkillGc(options: {
  apply: boolean;
  inventory: SkillGcInventory;
  deleteId: (id: string) => Promise<void>;
}): Promise<{ applied: boolean; eligibleIds: string[] }> {
  const eligibleIds = planSkillGarbage(options.inventory).items
    .filter((item) => item.eligible)
    .map((item) => item.id);
  if (!options.apply) return { applied: false, eligibleIds };
  for (const id of eligibleIds) await options.deleteId(id);
  return { applied: true, eligibleIds };
}

export async function collectSkillStorageInventory(input: {
  storageRoot: string;
  nowMs: number;
  referencedBlobHashes: Set<string>;
  currentReleaseIds: Set<string>;
  activePinReleaseIds: Set<string>;
  importSessions: SkillGcSession[];
  runEvents: SkillGcEvent[];
  runPins: SkillGcPin[];
}): Promise<SkillGcInventory> {
  const blobs: SkillGcBlob[] = [];
  const blobNames = await readdir(join(input.storageRoot, 'blobs')).catch(() => [] as string[]);
  for (const name of blobNames) {
    if (!isSha256Hex(name)) continue;
    const fileStat = await stat(join(input.storageRoot, 'blobs', name));
    if (!fileStat.isFile()) continue;
    blobs.push({
      hash: name,
      mtimeMs: fileStat.mtimeMs,
      referenced: input.referencedBlobHashes.has(name),
    });
  }

  const releases: SkillGcRelease[] = [];
  const staging: SkillGcStaging[] = [];
  const releasesRoot = join(input.storageRoot, 'releases');
  const skillDirs = await readdir(releasesRoot).catch(() => [] as string[]);
  for (const skillId of skillDirs) {
    const versionDirs = await readdir(join(releasesRoot, skillId)).catch(() => [] as string[]);
    for (const version of versionDirs) {
      const children = await readdir(join(releasesRoot, skillId, version), { withFileTypes: true })
        .catch(() => []);
      for (const child of children) {
        if (!child.isDirectory()) continue;
        const abs = join(releasesRoot, skillId, version, child.name);
        const dirStat = await stat(abs);
        if (child.name.startsWith('.staging-')) {
          staging.push({ id: child.name, mtimeMs: dirStat.mtimeMs });
          continue;
        }
        if (!isSha256Hex(child.name)) continue;
        const id = `${skillId}/${version}/${child.name}`;
        releases.push({
          id,
          mtimeMs: dirStat.mtimeMs,
          currentPublished: input.currentReleaseIds.has(id),
          activePin: input.activePinReleaseIds.has(id),
        });
      }
    }
  }

  return {
    nowMs: input.nowMs,
    blobs,
    releases,
    staging,
    importSessions: input.importSessions,
    runEvents: input.runEvents,
    runPins: input.runPins,
  };
}

type LabeledContainer = {
  Id: string;
  Created?: string | number;
  Config?: { Labels?: Record<string, string> };
};

function containerAgedOut(container: LabeledContainer, now: number, maxAgeMs: number): boolean {
  if (maxAgeMs <= 0) return true;
  const createdMs = container.Created;
  if (typeof createdMs === 'string') {
    const parsed = Date.parse(createdMs);
    return Number.isFinite(parsed) && now - parsed >= maxAgeMs;
  }
  if (typeof createdMs === 'number' && createdMs > 0) {
    const ms = createdMs < 1e12 ? createdMs * 1000 : createdMs;
    return now - ms >= maxAgeMs;
  }
  return false;
}

/**
 * Dry-run lists orphan skill containers. Apply removes only `nero.skill-run=1`
 * containers that are old enough, and never `nero.sandbox=1` user sandboxes.
 */
export async function reconcileOrphanSkillContainers(
  engine: {
    findLabeled: (label: string, value: string) => Promise<LabeledContainer[]>;
    remove: (id: string, force?: boolean) => Promise<unknown>;
  },
  options: { apply: boolean; now?: number; maxAgeMs?: number },
): Promise<{ removed: string[]; wouldRemove: string[]; skipped: string[] }> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? skillScriptOrphanMaxAgeMs();
  const report = { removed: [] as string[], wouldRemove: [] as string[], skipped: [] as string[] };
  const labeled = await engine.findLabeled(SKILL_SCRIPT_RUN_LABEL, '1');
  for (const container of labeled) {
    if (container.Config?.Labels?.['nero.sandbox'] === '1') {
      report.skipped.push(container.Id);
      continue;
    }
    if (!containerAgedOut(container, now, maxAgeMs)) {
      report.skipped.push(container.Id);
      continue;
    }
    report.wouldRemove.push(container.Id);
    if (!options.apply) continue;
    await engine.remove(container.Id, true);
    report.removed.push(container.Id);
  }
  return report;
}

export async function loadProductionGcInventory(nowMs = Date.now()): Promise<SkillGcInventory> {
  const pool = getPool();
  const root = getSkillsStorageRoot();
  const referenced = await pool.query<{ blob_hash: string }>(
    `SELECT DISTINCT blob_hash FROM app_skill_files`,
  );
  const current = await pool.query<{ skill_id: string; version: number; manifest_hash: string }>(
    `SELECT s.id AS skill_id, s.published_version AS version, v.manifest_hash
     FROM app_skills s
     JOIN app_skill_versions v ON v.skill_id = s.id AND v.version = s.published_version
     WHERE s.deleted_at IS NULL AND s.published_version IS NOT NULL AND v.manifest_hash IS NOT NULL`,
  );
  const pins = await pool.query<{
    id: string;
    skill_id: string;
    version: number;
    manifest_hash: string;
    expires_at: Date;
  }>(
    `SELECT server_execution_id || ':' || skill_id::text AS id,
            skill_id, version, manifest_hash, expires_at
     FROM app_skill_run_pins`,
  );
  const sessions = await pool.query<{
    id: string;
    kind: 'import' | 'sync';
    expires_at: Date;
    temp_root: string;
  }>(
    `SELECT id::text AS id, kind, expires_at, temp_root
     FROM app_skill_sync_sessions
     WHERE status = 'pending'`,
  );
  const events = await pool.query<{ id: string; event: string; created_at: Date }>(
    `SELECT id::text AS id, event, created_at FROM app_skill_events`,
  );

  const activePinReleaseIds = new Set<string>();
  for (const pin of pins.rows) {
    if (pin.expires_at.getTime() > nowMs) {
      activePinReleaseIds.add(`${pin.skill_id}/${pin.version}/${pin.manifest_hash}`);
    }
  }

  return collectSkillStorageInventory({
    storageRoot: root,
    nowMs,
    referencedBlobHashes: new Set(referenced.rows.map((row) => row.blob_hash)),
    currentReleaseIds: new Set(current.rows.map((row) => `${row.skill_id}/${row.version}/${row.manifest_hash}`)),
    activePinReleaseIds,
    importSessions: sessions.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      expiresAtMs: row.expires_at.getTime(),
      path: row.temp_root,
    })),
    runEvents: events.rows.map((row) => ({
      id: row.id,
      event: row.event,
      createdAtMs: row.created_at.getTime(),
    })),
    runPins: pins.rows.map((row) => ({
      id: row.id,
      expiresAtMs: row.expires_at.getTime(),
      renewed: row.expires_at.getTime() > nowMs,
    })),
  });
}

export async function applyProductionGc(options: {
  apply: boolean;
  inventory?: SkillGcInventory;
  /** Dependency injection for deterministic race tests. */
  pool?: Pool;
  loadInventory?: () => Promise<SkillGcInventory>;
}): Promise<{ applied: boolean; eligibleIds: string[] }> {
  const loadInventory = options.loadInventory ?? loadProductionGcInventory;
  if (!options.apply) {
    return runSkillGc({ apply: false, inventory: options.inventory ?? await loadInventory(), deleteId: async () => {} });
  }
  const pool = options.pool ?? getPool();
  return withSkillStorageWriteLock(pool, async () => {
    // A caller's dry-run/snapshot is never deletion authority. Publishers, pin
    // writers and resource saves cannot race this fresh scan while we hold the lease.
    const inventory = await loadInventory();
  const plan = planSkillGarbage(inventory);
  const eligible = new Set(plan.items.filter((item) => item.eligible).map((item) => item.id));
  return runSkillGc({
    apply: options.apply,
    inventory,
    deleteId: async (id) => {
      if (!eligible.has(id)) return;
      const item = plan.items.find((candidate) => candidate.id === id && candidate.eligible);
      if (!item) return;
      if (item.kind === 'blob') {
        if (inventory.blobs.some((blob) => blob.hash === id && blob.referenced)) return;
        await rm(join(getSkillsStorageRoot(), 'blobs', id), { force: true });
        return;
      }
      if (item.kind === 'release') {
        const release = inventory.releases.find((row) => row.id === id);
        if (!release || release.currentPublished || release.activePin) return;
        const [skillId, version, hash] = id.split('/');
        if (!skillId || !version || !hash || !isSha256Hex(hash)) return;
        await rm(join(getSkillsStorageRoot(), 'releases', skillId, version, hash), { recursive: true, force: true });
        return;
      }
      if (item.kind === 'staging') {
        await rmStagingById(id);
        return;
      }
      if (item.kind === 'import-temp') {
        const session = inventory.importSessions.find((row) => row.id === id);
        if (!session) return;
        await rm(session.path, { recursive: true, force: true });
        await pool.query(
          `DELETE FROM app_skill_sync_sessions WHERE id::text = $1 AND status = 'pending'`,
          [id],
        );
        return;
      }
      if (item.kind === 'run-event') {
        await pool.query(
          `DELETE FROM app_skill_events
           WHERE id::text = $1 AND event = ANY($2::text[])
             AND created_at <= now() - ($3::bigint * interval '1 millisecond')`,
          [id, [...RUN_AUDIT_EVENTS], SKILL_AUDIT_RUN_RETENTION_MS],
        );
        return;
      }
      if (item.kind === 'run-pin') {
        const [serverExecutionId, skillId] = id.split(':');
        if (!serverExecutionId || !skillId) return;
        await pool.query(
          `DELETE FROM app_skill_run_pins
           WHERE server_execution_id = $1 AND skill_id::text = $2
             AND expires_at <= now() - ($3::bigint * interval '1 millisecond')`,
          [serverExecutionId, skillId, SKILL_RUN_PIN_ENDED_GRACE_MS],
        );
      }
    },
  });
  });
}

async function rmStagingById(id: string): Promise<void> {
  const root = join(getSkillsStorageRoot(), 'releases');
  const skillDirs = await readdir(root).catch(() => [] as string[]);
  for (const skillId of skillDirs) {
    const versions = await readdir(join(root, skillId)).catch(() => [] as string[]);
    for (const version of versions) {
      const candidate = join(root, skillId, version, id);
      const fileStat = await stat(candidate).catch(() => null);
      if (fileStat?.isDirectory() && id.startsWith('.staging-')) {
        await rm(candidate, { recursive: true, force: true });
      }
    }
  }
}
