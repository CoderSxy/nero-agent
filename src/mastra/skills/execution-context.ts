import { randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import { trustedAuth } from '../auth/auth-context';
import type { SkillRepository } from './repository';
import type { SkillExecutionContext, SkillPin } from './types';
import {
  SELECTED_SKILL_IDS_CONTEXT_KEY,
  SERVER_EXECUTION_ID_CONTEXT_KEY,
  SKILL_LIMITS,
  SKILL_THREAD_ID_CONTEXT_KEY,
} from './validation';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Server-only authority for skill pins. WeakMap cannot be forged via client-writable
 * `requestContext.set('nero-agent.server-execution-id', ...)`.
 */
const boundServerExecutionIds = new WeakMap<object, string>();
const boundSkillThreadIds = new WeakMap<object, string>();

export type ResolveSkillExecutionInput = {
  requestContext: RequestContext;
  /** Server-owned Mastra runId from processInputStep / result.runId — never client body. */
  serverExecutionId: string;
  threadId: string;
  repository: SkillRepository;
};

/**
 * Build a trusted SkillExecutionContext from server fields only.
 * Client-supplied runId/owner/roles/version in requestContext are ignored for pins.
 */
export async function resolveSkillExecution(
  input: ResolveSkillExecutionInput,
): Promise<SkillExecutionContext> {
  // Pin lookup and renewal must be one protected operation: GC must not take
  // its expiry snapshot between them and delete a release being recovered.
  const recover = () => resolveSkillExecutionUnlocked(input);
  return input.repository.withStorageReadLock
    ? input.repository.withStorageReadLock(recover)
    : recover();
}

async function resolveSkillExecutionUnlocked(
  input: ResolveSkillExecutionInput,
): Promise<SkillExecutionContext> {
  const auth = trustedAuth(input.requestContext);
  const serverExecutionId = input.serverExecutionId.trim();
  if (!serverExecutionId) {
    throw new Error('serverExecutionId is required');
  }
  const threadId = input.threadId.trim();
  if (!threadId || threadId === 'no-thread') {
    throw new Error('threadId is required');
  }

  // Authority: WeakMap only. String keys are non-authoritative mirrors for diagnostics.
  bindSkillServerExecutionId(input.requestContext, serverExecutionId);
  bindSkillThreadId(input.requestContext, threadId);

  const pins = new Map<string, SkillPin>();
  const stored = await input.repository.listRunPins({
    serverExecutionId,
    userId: auth.userId,
    threadId,
  });
  for (const row of stored) {
    pins.set(row.skillId, {
      skillId: row.skillId,
      name: row.name,
      version: row.version,
      manifestHash: row.manifestHash,
    });
  }

  if (pins.size > 0) {
    await input.repository.touchRunPins({
      serverExecutionId,
      userId: auth.userId,
      threadId,
      skillIds: [...pins.keys()],
      ttlMs: SKILL_LIMITS.RUN_PIN_TTL_MS,
    });
  }

  return { serverExecutionId, auth, threadId, pins,
    loadedSkillIds: new Set(stored.filter(row => row.instructionsLoaded).map(row => row.skillId)) };
}

/** Read selected skill UUID intents from requestContext (non-authoritative). */
export function readSelectedSkillIds(requestContext: RequestContext | undefined): string[] {
  if (!requestContext) return [];
  const raw = requestContext.get(SELECTED_SKILL_IDS_CONTEXT_KEY);
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!UUID_RE.test(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= SKILL_LIMITS.SELECTED_SKILL_IDS_MAX) break;
  }
  return out;
}

/** Bound server execution id (WeakMap). Ignores client-writable string keys. */
export function readBoundServerExecutionId(requestContext: RequestContext | undefined): string | null {
  if (!requestContext) return null;
  const value = boundServerExecutionIds.get(requestContext);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Bound skill thread id (WeakMap). Ignores client-writable string keys. */
export function readBoundSkillThreadId(requestContext: RequestContext | undefined): string | null {
  if (!requestContext) return null;
  const value = boundSkillThreadIds.get(requestContext);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Alias of readBoundServerExecutionId — string-key reads are not authoritative. */
export function readServerExecutionId(requestContext: RequestContext | undefined): string | null {
  return readBoundServerExecutionId(requestContext);
}

/** Alias of readBoundSkillThreadId — string-key reads are not authoritative. */
export function readSkillThreadId(requestContext: RequestContext | undefined): string | null {
  return readBoundSkillThreadId(requestContext);
}

/**
 * Bind the Mastra generate/stream `runId` into a server-only WeakMap so processors/tools
 * can pin before processInputStep.runId is populated (often undefined on 1.71.0).
 * Returns the id to pass as `generate({ runId })` / `resumeGenerate(..., { runId })`.
 *
 * Also mirrors to the string context key for diagnostics only — authority is WeakMap.
 */
export function bindSkillServerExecutionId(
  requestContext: RequestContext,
  serverExecutionId?: string,
): string {
  const id = (serverExecutionId?.trim() || randomUUID());
  boundServerExecutionIds.set(requestContext, id);
  requestContext.set(SERVER_EXECUTION_ID_CONTEXT_KEY, id);
  return id;
}

/** Bind a trusted thread id (WeakMap). Never use client-only string keys as authority. */
export function bindSkillThreadId(requestContext: RequestContext, threadId: string): string {
  const id = threadId.trim();
  if (!id || id === 'no-thread') {
    throw new Error('threadId is required');
  }
  boundSkillThreadIds.set(requestContext, id);
  requestContext.set(SKILL_THREAD_ID_CONTEXT_KEY, id);
  return id;
}

function threadIdFromMemory(memory: unknown): string | null {
  if (!memory || typeof memory !== 'object') return null;
  const thread = (memory as { thread?: unknown }).thread;
  if (typeof thread === 'string' && thread.trim() && thread.trim() !== 'no-thread') {
    return thread.trim();
  }
  if (thread && typeof thread === 'object' && typeof (thread as { id?: unknown }).id === 'string') {
    const id = String((thread as { id: string }).id).trim();
    if (id && id !== 'no-thread') return id;
  }
  return null;
}

export type SkillRunOptionsBind = {
  requestContext?: RequestContext;
  runId?: string;
  threadId?: string;
  memory?: { thread?: unknown; resource?: string; options?: unknown };
  [key: string]: unknown;
};

/**
 * Ensure server-owned runId + thread bindings for generate/stream/resume entrypoints.
 * Resume requires an explicit runId (fail closed).
 */
export function prepareSkillRunOptions<T extends SkillRunOptionsBind>(
  options: T | undefined,
  mode: 'start' | 'resume',
): T & { requestContext: RequestContext; runId: string } {
  const opts = { ...(options ?? {}) } as T;
  const rc = opts.requestContext ?? new RequestContext();

  let runId: string;
  if (mode === 'resume') {
    const provided = typeof opts.runId === 'string' ? opts.runId.trim() : '';
    if (!provided) {
      throw new Error('Skill resume requires a server runId');
    }
    runId = bindSkillServerExecutionId(rc, provided);
  } else {
    runId = bindSkillServerExecutionId(rc, typeof opts.runId === 'string' ? opts.runId : undefined);
  }

  const threadId =
    (typeof opts.threadId === 'string' && opts.threadId.trim() && opts.threadId.trim() !== 'no-thread'
      ? opts.threadId.trim()
      : null)
    ?? threadIdFromMemory(opts.memory)
    ?? readBoundSkillThreadId(rc);
  if (threadId) {
    bindSkillThreadId(rc, threadId);
  }

  return { ...opts, requestContext: rc, runId };
}
