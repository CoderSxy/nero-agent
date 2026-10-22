import { createHash } from 'node:crypto';
import { SkillStorageError } from './errors';
import { computeManifestHash } from './release-store';
import type { BlobStore } from './blob-store';
import type { ReleaseStore } from './release-store';
import type { ReconcileTarget } from './reconcile';
import type { SkillStorageHealth } from './types';

export type { SkillStorageHealth };

export type SkillHealthResource = {
  path: string;
  code: string;
};

export type SkillHealthReport = {
  skillId: string;
  version: number;
  manifestHash: string;
  status: Exclude<SkillStorageHealth, 'unknown' | 'checking'>;
  checkedAt: string;
  safeCode: string | null;
  resourceCount: number;
  missingCount: number;
  corruptCount: number;
  resources: SkillHealthResource[];
};

export type SafeSkillHealth = {
  skillId: string;
  version: number;
  manifestHash: string;
  status: SkillStorageHealth;
  checkedAt: string | null;
  safeCode: string | null;
  resourceCount: number;
  missingCount: number;
  corruptCount: number;
  resources?: SkillHealthResource[];
};

export type HealthDeps = {
  releaseStore: Pick<ReleaseStore, 'verifyRelease'>;
  blobStore: Pick<BlobStore, 'openVerified'>;
  now?: () => Date;
};

export class SkillHealthInfrastructureError extends Error {
  readonly code = 'HEALTH_INFRA';

  constructor() {
    super('Skill storage health check failed');
    this.name = 'SkillHealthInfrastructureError';
  }
}

const RESOURCE_LIMIT = 50;

export function skillDoctorExitCode(input: {
  reports: Array<{ status: string }>;
  infrastructureFailure: boolean;
}): number {
  if (input.infrastructureFailure) return 1;
  if (input.reports.some(report => report.status === 'unavailable')) return 2;
  return 0;
}

export function redactHealthReport<T extends { resources?: SkillHealthResource[]; safeCode?: string | null }>(report: T): T {
  const resources = (report.resources ?? []).slice(0, RESOURCE_LIMIT).map(resource => ({
    path: safeRelativePath(resource.path),
    code: safeToken(resource.code),
  }));
  return { ...report, resources, safeCode: report.safeCode ? safeToken(report.safeCode) : report.safeCode };
}

export function toSafeSkillHealth(report: SkillHealthReport | StoredSkillHealth, includeResources: boolean): SafeSkillHealth {
  const safe = redactHealthReport(report);
  const projected: SafeSkillHealth = {
    skillId: safe.skillId,
    version: safe.version,
    manifestHash: safe.manifestHash,
    status: safe.status,
    checkedAt: safe.checkedAt,
    safeCode: safe.safeCode,
    resourceCount: safe.resourceCount,
    missingCount: safe.missingCount,
    corruptCount: safe.corruptCount,
  };
  if (includeResources) projected.resources = safe.resources;
  return projected;
}

export type StoredSkillHealth = {
  skillId: string;
  version: number;
  manifestHash: string;
  status: SkillStorageHealth;
  checkedAt: string | null;
  checkingStartedAt: string | null;
  safeCode: string | null;
  resourceCount: number;
  missingCount: number;
  corruptCount: number;
  resources: SkillHealthResource[];
};

export type SkillHealthRepository = {
  upsert(row: StoredSkillHealth): Promise<void>;
  get(skillId: string, version: number, manifestHash: string): Promise<StoredSkillHealth | null>;
};

const inflight = new Map<string, Promise<SkillHealthReport>>();

export function resetSkillHealthRechecks(): void {
  inflight.clear();
}

export async function inspectSkillStorage(target: ReconcileTarget, deps: HealthDeps): Promise<SkillHealthReport> {
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  const base = {
    skillId: target.skillId,
    version: target.version,
    manifestHash: target.manifestHash,
    checkedAt,
    resourceCount: target.entries.length,
    resources: [] as SkillHealthResource[],
  };
  let expectedHash: string;
  try {
    expectedHash = computeManifestHash(target.skillMd, target.entries);
  } catch (error) {
    throw asInfrastructure(error);
  }
  if (expectedHash !== target.manifestHash) {
    return {
      ...base,
      status: 'unavailable',
      safeCode: 'RELEASE_HASH_MISMATCH',
      missingCount: 0,
      corruptCount: 1,
    };
  }

  const resources: SkillHealthResource[] = [];
  let missingCount = 0;
  let corruptCount = 0;
  for (const entry of target.entries) {
    const outcome = await readBlob(deps.blobStore, entry.blobHash);
    if (outcome === 'ok') continue;
    resources.push({ path: safeRelativePath(entry.path), code: outcome.code });
    if (outcome.missing) missingCount += 1;
    else corruptCount += 1;
  }
  if (missingCount > 0 || corruptCount > 0) {
    return {
      ...base,
      status: 'unavailable',
      safeCode: resources[0]?.code ?? 'BLOB_MISSING',
      missingCount,
      corruptCount,
      resources: resources.slice(0, RESOURCE_LIMIT),
    };
  }

  const skillBlob = await readBlob(deps.blobStore, hashText(target.skillMd));
  if (skillBlob !== 'ok' && skillBlob.code !== 'BLOB_MISSING' && skillBlob.code !== 'BLOB_HASH_MISMATCH') {
    throw new SkillHealthInfrastructureError();
  }

  try {
    await deps.releaseStore.verifyRelease(target.skillId, target.version, target.manifestHash);
  } catch (error) {
    if (error instanceof SkillHealthInfrastructureError) throw error;
    if (!(error instanceof SkillStorageError)) throw new SkillHealthInfrastructureError();
    if (error.code !== 'RELEASE_INCOMPLETE' && error.code !== 'RELEASE_HASH_MISMATCH') {
      throw new SkillHealthInfrastructureError();
    }
    return {
      ...base,
      status: 'repairable',
      safeCode: error.code,
      missingCount: 0,
      corruptCount: 0,
      resources: [],
    };
  }

  return {
    ...base,
    status: 'healthy',
    safeCode: null,
    missingCount: 0,
    corruptCount: 0,
    resources: [],
  };
}

export type RecheckInput = {
  target: ReconcileTarget;
  repair: boolean;
  includeResources: boolean;
  inspect: (target: ReconcileTarget) => Promise<SkillHealthReport>;
  repairTarget?: (target: ReconcileTarget) => Promise<void>;
  repository: SkillHealthRepository;
  timeoutMs?: number;
  now?: () => Date;
};

export async function recheckSkillStorage(input: RecheckInput): Promise<{ status: 'done' | 'checking'; report?: SafeSkillHealth }> {
  const key = `${input.target.skillId}:${input.target.version}:${input.target.manifestHash}`;
  const now = input.now ?? (() => new Date());
  let job = inflight.get(key);
  if (!job) {
    job = runRecheck(input, now).finally(() => {
      if (inflight.get(key) === job) inflight.delete(key);
    });
    inflight.set(key, job);
  }
  const timeoutMs = input.timeoutMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const winner = await Promise.race([job.then(report => ({ kind: 'done' as const, report })), timeout.then(() => ({ kind: 'timeout' as const }))]);
  clearTimeout(timer);
  if (winner.kind === 'timeout') {
    const stored = await input.repository.get(input.target.skillId, input.target.version, input.target.manifestHash);
    return {
      status: 'checking',
      report: stored ? toSafeSkillHealth(stored, input.includeResources) : {
        skillId: input.target.skillId,
        version: input.target.version,
        manifestHash: input.target.manifestHash,
        status: 'checking',
        checkedAt: null,
        safeCode: null,
        resourceCount: input.target.entries.length,
        missingCount: 0,
        corruptCount: 0,
      },
    };
  }
  return { status: 'done', report: toSafeSkillHealth(winner.report, input.includeResources) };
}

async function runRecheck(input: RecheckInput, now: () => Date): Promise<SkillHealthReport> {
  const started = now().toISOString();
  await input.repository.upsert({
    skillId: input.target.skillId,
    version: input.target.version,
    manifestHash: input.target.manifestHash,
    status: 'checking',
    checkedAt: null,
    checkingStartedAt: started,
    safeCode: null,
    resourceCount: input.target.entries.length,
    missingCount: 0,
    corruptCount: 0,
    resources: [],
  });
  try {
    if (input.repair) {
      if (!input.repairTarget) throw new SkillHealthInfrastructureError();
      await input.repairTarget(input.target);
    }
    const report = await input.inspect(input.target);
    await input.repository.upsert({ ...report, checkingStartedAt: null });
    return report;
  } catch (error) {
    if (error instanceof SkillHealthInfrastructureError || !(error instanceof SkillStorageError)) {
      throw new SkillHealthInfrastructureError();
    }
    throw error;
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

async function readBlob(
  blobStore: Pick<BlobStore, 'openVerified'>,
  hash: string,
): Promise<'ok' | { code: string; missing: boolean }> {
  try {
    const stream = await blobStore.openVerified(hash);
    for await (const _chunk of stream) {
      // Drain so the hash check inside openVerified finishes.
    }
    return 'ok';
  } catch (error) {
    if (error instanceof SkillStorageError) {
      if (error.code === 'BLOB_MISSING') return { code: 'BLOB_MISSING', missing: true };
      if (error.code === 'BLOB_HASH_MISMATCH') return { code: 'BLOB_HASH_MISMATCH', missing: false };
      if (error.code === 'INVALID_HASH') return { code: 'BLOB_HASH_MISMATCH', missing: false };
      throw new SkillHealthInfrastructureError();
    }
    const errno = (error as { code?: string }).code;
    if (errno === 'EACCES' || errno === 'EPERM' || errno === 'EIO' || errno === 'EROFS') {
      return { code: 'BLOB_UNREADABLE', missing: false };
    }
    throw new SkillHealthInfrastructureError();
  }
}

function asInfrastructure(error: unknown): SkillHealthInfrastructureError {
  if (error instanceof SkillHealthInfrastructureError) return error;
  return new SkillHealthInfrastructureError();
}

function safeRelativePath(path: string): string {
  if (!path || path.startsWith('/') || path.includes('..') || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')) {
    return 'resource';
  }
  return path.slice(0, 512);
}

function safeToken(value: string): string {
  return /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'STORAGE_UNAVAILABLE';
}
